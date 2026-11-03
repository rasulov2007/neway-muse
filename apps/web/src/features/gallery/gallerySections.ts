/** Section registry: drives the sticky index, the anchors and the test. Order is the page order. */
export interface GallerySectionDef {
  id: string;
  title: string;
}

export const GALLERY_SECTIONS: GallerySectionDef[] = [
  { id: 'foundations', title: 'Foundations' },
  { id: 'buttons', title: 'Buttons' },
  { id: 'inputs', title: 'Inputs' },
  { id: 'form', title: 'Form' },
  { id: 'badges', title: 'Badges & Avatars' },
  { id: 'cards', title: 'Cards & KPI cards' },
  { id: 'tables', title: 'Tables' },
  { id: 'navigation', title: 'Navigation' },
  { id: 'overlays', title: 'Overlays' },
  { id: 'feedback', title: 'Feedback' },
  { id: 'timeline', title: 'Timeline & Activity' },
  { id: 'charts', title: 'Charts' },
];
