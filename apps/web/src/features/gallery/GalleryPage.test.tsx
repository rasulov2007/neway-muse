import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { GalleryPage } from './GalleryPage';
import { GALLERY_SECTIONS } from './gallerySections';

const TITLES = [
  'Foundations',
  'Buttons',
  'Inputs',
  'Form',
  'Badges & Avatars',
  'Cards & KPI cards',
  'Tables',
  'Navigation',
  'Overlays',
  'Feedback',
  'Timeline & Activity',
  'Charts',
];

describe('GalleryPage', () => {
  it('renders the page header with a single h1', async () => {
    renderPage(<GalleryPage />, { routePath: '/dev/gallery', path: '/dev/gallery' });
    const h1s = await screen.findAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Component gallery');
    expect(
      screen.getByText(
        'Every reusable component in every state. The visual reference for all modules.',
      ),
    ).toBeInTheDocument();
  });

  it('renders all twelve sections as <section id> with an h2', async () => {
    renderPage(<GalleryPage />, { routePath: '/dev/gallery', path: '/dev/gallery' });
    await screen.findByRole('heading', { level: 1 });
    expect(GALLERY_SECTIONS.map((s) => s.title)).toEqual(TITLES);
    for (const section of GALLERY_SECTIONS) {
      const el = document.getElementById(section.id);
      expect(el, section.id).not.toBeNull();
      expect(el?.tagName).toBe('SECTION');
      expect(
        within(el as HTMLElement).getByRole('heading', { level: 2, name: section.title }),
      ).toBeInTheDocument();
    }
  });

  it('renders an index link per section', async () => {
    renderPage(<GalleryPage />, { routePath: '/dev/gallery', path: '/dev/gallery' });
    const nav = await screen.findByRole('navigation', { name: 'Section index' });
    for (const section of GALLERY_SECTIONS) {
      expect(within(nav).getByRole('link', { name: new RegExp(section.title) })).toHaveAttribute(
        'href',
        `#${section.id}`,
      );
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(TITLES.length);
  });

  it('shows every status code and realistic demo content', async () => {
    renderPage(<GalleryPage />, { routePath: '/dev/gallery', path: '/dev/gallery' });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByText('Out of service').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Unit 2785/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/L-100245/).length).toBeGreaterThan(0);
  });
});
