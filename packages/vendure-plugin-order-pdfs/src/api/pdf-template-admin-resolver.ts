import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  Allow,
  Ctx,
  PermissionDefinition,
  RequestContext,
} from '@vendure/core';
import {
  CreatePdfTemplateMutationVariables,
  DeletePdfTemplateMutationVariables,
  PdfTemplate,
  PdfTemplateInput,
  PdfTemplateList,
  UpdatePdfTemplateMutationVariables,
} from '../ui/generated/graphql';
import { OrderPDFsService } from './order-pdfs.service';
import { CreatePdfTemplates, DeletePdfTemplates, ReadPdfTemplates, UpdatePdfTemplates } from './order-pdfs-permissions';

@Resolver()
export class PDFTemplateAdminResolver {
  constructor(private readonly service: OrderPDFsService) { }

  @Mutation()
  @Allow(CreatePdfTemplates.Permission)
  async createPDFTemplate(
    @Ctx() ctx: RequestContext,
    @Args() args: CreatePdfTemplateMutationVariables
  ): Promise<PdfTemplate> {
    return await this.service.createPDFTemplate(ctx, args.input);
  }

  @Mutation()
  @Allow(UpdatePdfTemplates.Permission)
  async updatePDFTemplate(
    @Ctx() ctx: RequestContext,
    @Args() args: UpdatePdfTemplateMutationVariables
  ): Promise<PdfTemplate> {
    return await this.service.updateTemplate(ctx, args.id, args.input);
  }

  @Mutation()
  @Allow(DeletePdfTemplates.Permission)
  async deletePDFTemplate(
    @Ctx() ctx: RequestContext,
    @Args() args: DeletePdfTemplateMutationVariables
  ): Promise<PdfTemplate[]> {
    return await this.service.deletePDFTemplate(ctx, args.id);
  }

  @Query()
  @Allow(ReadPdfTemplates.Permission)
  async pdfTemplates(@Ctx() ctx: RequestContext): Promise<PdfTemplateList> {
    const result = await this.service.getTemplates(ctx);
    return {
      items: result,
      totalItems: result.length,
    };
  }
}
