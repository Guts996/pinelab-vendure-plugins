import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SortOrder } from '@vendure/common/lib/generated-shop-types';
import {
  ID,
  Injector,
  Logger,
  Order,
  OrderService,
  RequestContext,
  TransactionalConnection,
  UserInputError,
  ForbiddenError,
  EntityNotFoundError,
  ChannelService,
  ListQueryBuilder,
  ChannelAware,
  Channel,
} from '@vendure/core';
import { createReadStream, ReadStream } from 'fs';
import Handlebars from 'handlebars';
import { loggerCtx, PLUGIN_INIT_OPTIONS } from '../constants';
import { PDFTemplatePluginOptions } from '../order-pdfs-plugin';
import { PdfTemplateInput } from '../ui/generated/graphql';
import {
  createTempFile,
  safeRemoveFile,
  zipFiles,
  ZippableFile,
} from './file.util';
import { PDFTemplateEntity } from './pdf-template.entity';
import puppeteer, { Browser } from 'puppeteer';
import { In } from 'typeorm';

/**
 * Service responsible for managing PDF template entities and generating PDFs
 * from templates for orders.
 * 
 * Follows Vendure's patterns for channel-aware entity management.
 * @see https://docs.vendure.io/guides/developer-guide/channels/
 */
@Injectable()
export class OrderPDFsService {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly orderService: OrderService,
    private readonly channelService: ChannelService, // Add ChannelService
    private readonly listQueryBuilder: ListQueryBuilder, // Add ListQueryBuilder
    private moduleRef: ModuleRef,
    @Inject(PLUGIN_INIT_OPTIONS)
    private options: PDFTemplatePluginOptions
  ) {
    Handlebars.registerHelper('formatMoney', (amount?: number) => {
      if (amount == null) {
        return amount;
      }
      return (amount / 100).toFixed(2);
    });
  }

  /**
   * Creates a new PDF template and assigns it to the specified channels.
   * If no channels specified, assigns to the current channel.
   * 
   * @param ctx - The request context
   * @param input - Template input data including optional channel IDs
   */
  async createPDFTemplate(
    ctx: RequestContext,
    input: PdfTemplateInput
  ): Promise<PDFTemplateEntity> {
    const repository = this.connection.getRepository(ctx, PDFTemplateEntity);

    // Check for duplicate name in current channel
    const qb = repository.createQueryBuilder('template')
      .leftJoin('template.channels', 'channel')
      .where('template.name = :name', { name: input.name })
      .andWhere('channel.id = :channelId', { channelId: ctx.channelId });

    const existing = await qb.getOne();

    if (existing) {
      throw new UserInputError(
        `A PDF template with name '${input.name}' already exists in this channel`
      );
    }

    // Create the new template entity
    const newTemplate = new PDFTemplateEntity({
      name: input.name,
      enabled: input.enabled,
      public: input.public,
      templateString: input.templateString,
    });

    // Assign to current channel (always include current channel)
    await this.channelService.assignToCurrentChannel(newTemplate, ctx);

    // Save to get an ID
    const savedTemplate = await repository.save(newTemplate);

    // If additional channels specified, assign to those as well
    if (input.channelIds && input.channelIds.length > 0) {
      // Filter out current channel ID to avoid duplicates
      const additionalChannelIds = input.channelIds.filter(
        id => id.toString() !== ctx.channelId?.toString()
      );

      if (additionalChannelIds.length > 0) {
        await this.channelService.assignToChannels(
          ctx,
          PDFTemplateEntity,
          savedTemplate.id,
          additionalChannelIds
        );
      }
    }

    const freshTemplate = await this.connection.findOneInChannel(
      ctx,
      PDFTemplateEntity,
      savedTemplate.id,
      ctx.channelId,
      { relations: ['channels'] }
    );
    if (!freshTemplate) {
      throw new EntityNotFoundError('PDFTemplateEntity', savedTemplate.id);
    }
    return freshTemplate;
  }

  /**
   * Updates an existing PDF template, possibly changing its channel associations.
   * 
   * @param ctx - The request context
   * @param id - The ID of the template to update
   * @param input - The input data for the update
   */
  async updateTemplate(
    ctx: RequestContext,
    id: ID,
    input: PdfTemplateInput
  ): Promise<PDFTemplateEntity> {
    const repository = this.connection.getRepository(ctx, PDFTemplateEntity);

    // Find the template in the current channel
    const existing = await this.connection.findOneInChannel(
      ctx,
      PDFTemplateEntity,
      id,
      ctx.channelId,
      { relations: ['channels'] }
    );

    if (!existing) {
      throw new EntityNotFoundError('PDFTemplateEntity', id);
    }

    // Update basic properties
    const updated = await repository.save({
      ...existing,
      name: input.name,
      enabled: input.enabled,
      public: input.public,
      templateString: input.templateString,
    });

    // Handle channel assignments if provided
    if (input.channelIds && input.channelIds.length > 0) {
      // Get current channel associations
      const currentChannels = await this.connection
        .getRepository(ctx, PDFTemplateEntity)
        .createQueryBuilder('template')
        .relation('channels')
        .of(id)
        .loadMany();

      const currentChannelIds = currentChannels.map(channel => channel.id.toString());

      // Always ensure current channel is included
      const targetChannelIds = [...new Set([
        ctx.channelId?.toString(),
        ...input.channelIds.map(id => id.toString())
      ])];

      // Calculate channels to add and remove
      const channelsToAdd = targetChannelIds.filter(
        cid => !currentChannelIds.includes(cid)
      );

      const channelsToRemove = currentChannelIds.filter(
        cid => !targetChannelIds.includes(cid) && cid !== ctx.channelId?.toString()
      );

      // Add new channels
      if (channelsToAdd.length > 0) {
        await this.channelService.assignToChannels(
          ctx,
          PDFTemplateEntity,
          id,
          channelsToAdd
        );
      }

      // Remove channels that are no longer needed
      if (channelsToRemove.length > 0) {
        await this.channelService.removeFromChannels(
          ctx,
          PDFTemplateEntity,
          id,
          channelsToRemove
        );
      }
    }

    // Return the updated entity with channels
    const freshTemplate = await this.connection.findOneInChannel(
      ctx,
      PDFTemplateEntity,
      id,
      ctx.channelId,
      { relations: ['channels'] }
    );
    if (!freshTemplate) {
      throw new EntityNotFoundError('PDFTemplateEntity', id);
    }
    return freshTemplate;
  }

  /**
   * Deletes a PDF template from the current channel.
   * If this is the last channel, removes the template entirely.
   * 
   * @param ctx - The request context
   * @param id - The ID of the template to delete
   */
  async deletePDFTemplate(
    ctx: RequestContext,
    id: ID
  ): Promise<PDFTemplateEntity[]> {
    const repository = this.connection.getRepository(ctx, PDFTemplateEntity);

    // Find the template in the current channel
    const existing = await this.connection.findOneInChannel(
      ctx,
      PDFTemplateEntity,
      id,
      ctx.channelId,
      { relations: ['channels'] }
    );

    if (!existing) {
      throw new EntityNotFoundError('PDFTemplateEntity', id);
    }

    // If this template exists in more than one channel, just remove from current channel
    if (existing.channels.length > 1) {
      await this.channelService.removeFromChannels(
        ctx,
        PDFTemplateEntity,
        id,
        [ctx.channelId]
      );
    } else {
      // If this is the only channel, delete the entire template
      await repository.remove(existing);
    }

    // Return updated list of templates for this channel
    return this.getTemplates(ctx);
  }

  /**
   * Gets all PDF templates available in the current channel.
   * 
   * @param ctx - The request context
   */
  async getTemplates(ctx: RequestContext): Promise<PDFTemplateEntity[]> {
    // Use listQueryBuilder to properly handle channel filtering
    // The options parameter accepts take, skip, sort, filter but not relations directly
    const qb = this.listQueryBuilder
      .build(PDFTemplateEntity, {}, { ctx, channelId: ctx.channelId });

    // Add relations manually to the QueryBuilder
    qb.leftJoinAndSelect('entity.channels', 'channel');

    // Return array of entities
    return qb.getMany();
  }

  /**
   * Finds a specific template by ID within the current channel.
   * 
   * @param ctx - The request context
   * @param id - The ID of the template to find
   */
  async findTemplate(
    ctx: RequestContext,
    id: ID
  ): Promise<PDFTemplateEntity | undefined> {
    return this.connection.findOneInChannel(
      ctx,
      PDFTemplateEntity,
      id,
      ctx.channelId,
      { relations: ['channels'] }
    );
  }

  /**
   * Generates an PDF for the latest placed order and the given template
   */
  async downloadPDF(
    ctx: RequestContext,
    templateId?: ID,
    templateString?: string,
    _order?: Order
  ): Promise<ReadStream> {
    let order = _order;
    if (!order) {
      order = await this.getLatestPlacedOrder(ctx);
    }
    if (!templateString && !templateId) {
      throw new UserInputError(
        `Need a template ID or template string to render PDF`
      );
    }
    if (!templateString) {
      const template = await this.findTemplate(ctx, templateId!);
      if (!template) {
        throw Error(`No template found with id '${templateId}'`);
      }
      templateString = template.templateString;
    }
    const { tempFilePath } = await this.generatePDF(ctx, templateString, order);
    const stream = createReadStream(tempFilePath);
    stream.on('finish', () => safeRemoveFile(tempFilePath));
    return stream;
  }

  async downloadMultiplePDFs(
    ctx: RequestContext,
    templateId: ID,
    orders: Order[]
  ) {
    // This is currently done in main thread, so a max of 10 orders is allowed
    if (orders.length > 10) {
      throw new UserInputError(`Max 10 orders allowed`);
    }
    const template = await this.findTemplate(ctx, templateId);
    if (!template) {
      throw Error(`No template found with id '${templateId}'`);
    }
    const pdfData = await Promise.all(
      orders.map(async (order) => {
        const hydratedOrder = await this.orderService.findOne(ctx, order.id);
        if (!hydratedOrder) {
          throw new UserInputError(`No Order with code ${order.code} found`);
        }
        return await this.generatePDF(
          ctx,
          template.templateString,
          hydratedOrder
        );
      })
    );
    const zippableFiles: ZippableFile[] = pdfData.map((pdf) => ({
      path: pdf.tempFilePath,
      name: pdf.orderCode + '.pdf',
    }));
    const zipFile = await zipFiles(zippableFiles);
    const stream = createReadStream(zipFile);
    stream.on('finish', () => safeRemoveFile(zipFile));
    return stream;
  }

  /**
   * Generate a PDF based on the given template string and order
   */
  async generatePDF(
    ctx: RequestContext,
    templateString: string,
    order: Order
  ): Promise<{ tempFilePath: string; orderCode: string }> {
    const data = await this.options.loadDataFn!(
      ctx,
      new Injector(this.moduleRef),
      order
    );
    const tmpFilePath = await createTempFile('.pdf');
    let browser: Browser | undefined;
    try {
      const compiledHtml = Handlebars.compile(templateString)(data);
      browser = await puppeteer.launch({
        headless: true,
        // We are not using puppeteer to fetch any external resources, so we dont care about the security concerns here
        args: ['--no-sandbox'],
      });
      const page = await browser.newPage();
      await page.setContent(compiledHtml);
      await page.pdf({
        path: tmpFilePath,
        format: 'A4',
        margin: { bottom: 100, top: 100, left: 50, right: 50 },
      });
    } catch (e) {
      // Warning, because this will be retried, or is returned to the user
      Logger.warn(
        `Failed to generate invoice: ${JSON.stringify((e as Error)?.message)}`,
        loggerCtx
      );
      throw e;
    } finally {
      if (browser) {
        // Prevent memory leaks
        browser.close().catch((e: Error) => {
          Logger.error(
            `Failed to close puppeteer browser: ${e?.message}`,
            loggerCtx
          );
        });
      }
    }
    return { tempFilePath: tmpFilePath, orderCode: order.code };
  }

  private async getLatestPlacedOrder(ctx: RequestContext): Promise<Order> {
    const orderId = (
      await this.orderService.findAll(
        ctx,
        {
          take: 1,
          filter: {
            orderPlacedAt: { isNull: false },
          },
          sort: { createdAt: SortOrder.DESC },
        },
        []
      )
    )?.items?.[0]?.id;
    // Refetch needed for relations to work
    const order = await this.orderService.findOne(ctx, orderId);
    if (!order) {
      throw new UserInputError(`No latest placed order found`);
    }
    return order;
  }
}