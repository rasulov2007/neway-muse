import { createFileRoute } from '@tanstack/react-router';
import { ViolationFormPage } from '@/features/safety/SafetyFormPages';

export const Route = createFileRoute('/safety/violations/new')({
  component: ViolationFormPage,
});
