/**
 * Permission definitions for the Order PDFs plugin.
 * 
 * This follows Vendure's permission pattern where each permission is defined with a name 
 * and description, and then registered with the auth system via the plugin configuration.
 * 
 * @see https://docs.vendure.io/reference/typescript-api/auth/permission-definition/
 */
import { PermissionDefinition } from '@vendure/core';

// View-only permission for listing templates
export const ReadPdfTemplates = new PermissionDefinition({
    name: 'ReadPdfTemplates',
    description: 'Allow listing and viewing PDF templates',
})

// Creation permission
export const CreatePdfTemplates = new PermissionDefinition({
    name: 'CreatePdfTemplates',
    description: 'Allow creating new PDF templates',
})

// Update permission
export const UpdatePdfTemplates = new PermissionDefinition({
    name: 'UpdatePdfTemplates',
    description: 'Allow updating existing PDF templates',
})

// Delete permission
export const DeletePdfTemplates = new PermissionDefinition({
    name: 'DeletePdfTemplates',
    description: 'Allow deleting PDF templates',
})

// Download permission
export const DownloadPdf = new PermissionDefinition({
    name: 'DownloadPdf',
    description: 'Allow generating and downloading PDFs',
})
