import { createFileRoute } from '@tanstack/react-router';
import { DocumentTemplatesPage } from '@/features/admin/DocumentTemplatesPage';

export const Route = createFileRoute('/admin/document-templates')({
  component: DocumentTemplatesPage,
});
