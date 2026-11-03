import { createFileRoute } from '@tanstack/react-router';
import { InspectionFormPage } from '@/features/safety/SafetyFormPages';

export const Route = createFileRoute('/safety/inspections/new')({
  component: InspectionFormPage,
});
