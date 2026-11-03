import { useEffect, useState } from 'react';
import { PageHeader, SectionLabel, cn } from '@/design-system';
import { GALLERY_SECTIONS } from './gallerySections';
import { BadgesSection } from './sections/BadgesSection';
import { ButtonsSection } from './sections/ButtonsSection';
import { CardsSection } from './sections/CardsSection';
import { ChartsSection } from './sections/ChartsSection';
import { FeedbackSection } from './sections/FeedbackSection';
import { FormExampleSection } from './sections/FormExampleSection';
import { FoundationsSection } from './sections/FoundationsSection';
import { InputsSection } from './sections/InputsSection';
import { NavigationSection } from './sections/NavigationSection';
import { OverlaysSection } from './sections/OverlaysSection';
import { TablesSection } from './sections/TablesSection';
import { TimelineSection } from './sections/TimelineSection';

/**
 * Tracks which section is in view. Observes the top band of the viewport so the highlighted item
 * is the section whose heading the reader is currently under.
 */
function useActiveSection(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        if (visible.size === 0) return;
        // The visible section closest to the top of the viewport wins.
        const next = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
        if (next) setActive(next);
      },
      { rootMargin: '-15% 0px -60% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

const sectionIds = GALLERY_SECTIONS.map((s) => s.id);

/** Every reusable component in every state, on one page with a sticky section index. */
export function GalleryPage() {
  const active = useActiveSection(sectionIds);

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Component gallery"
        description="Every reusable component in every state. The visual reference for all modules."
      />

      <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[12rem_minmax(0,1fr)]">
        <nav
          aria-label="Section index"
          className="xl:sticky xl:top-[calc(var(--topbar-height)+var(--page-padding))] xl:self-start"
        >
          <SectionLabel className="mb-2">On this page</SectionLabel>
          <ol className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm xl:flex-col xl:gap-0">
            {GALLERY_SECTIONS.map((section, i) => {
              const isActive = section.id === active;
              return (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    aria-current={isActive ? 'location' : undefined}
                    className={cn(
                      'flex h-7 items-center gap-2 rounded-sm px-2 text-secondary transition-colors duration-(--duration-fast) hover:bg-surface-hover hover:text-ink xl:-ml-2',
                      isActive &&
                        'bg-primary-soft font-medium text-primary-text hover:bg-primary-soft-hover hover:text-primary-text',
                    )}
                  >
                    <span className="tabular w-5 shrink-0 text-xs text-faint">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="truncate">{section.title}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-12">
          <FoundationsSection />
          <ButtonsSection />
          <InputsSection />
          <FormExampleSection />
          <BadgesSection />
          <CardsSection />
          <TablesSection />
          <NavigationSection />
          <OverlaysSection />
          <FeedbackSection />
          <TimelineSection />
          <ChartsSection />
        </div>
      </div>
    </div>
  );
}
