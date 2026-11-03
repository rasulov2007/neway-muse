// Fake documents for the Muse vision demo (hackathon, 2026-11-03). Everything here is fictional:
// names, licence numbers, brokers, MC numbers, addresses and rates are made up, and every
// document says SAMPLE on its face.
//
// Run from the repo root:  node scripts/hackathon/make-vision-samples.mjs
// Writes docs/hackathon/samples/*.png|*.jpg|*.pdf plus truth.json (the right answers).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

const OUT = join(process.cwd(), 'docs', 'hackathon', 'samples');
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------ CDL cards
// Colours here are print colours of a fictional card, not product UI.
function cdlCard(p) {
  const W = 1012;
  const H = 638;
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, p.tint[0]);
  grad.addColorStop(1, p.tint[1]);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(0, 0, W, H, 36);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillRect(0, 0, W, 96);
  g.fillStyle = '#1d2b4a';
  g.font = 'bold 34px Arial';
  g.fillText(p.stateName, 36, 52);
  g.font = 'bold 22px Arial';
  g.fillText('COMMERCIAL DRIVER LICENSE', 36, 84);
  g.font = 'bold 26px Arial';
  g.fillStyle = '#b3261e';
  g.fillText('SAMPLE · NOT A REAL ID', W - 360, 60);

  // Photo placeholder: a plain silhouette.
  g.fillStyle = '#c9ced6';
  g.fillRect(36, 124, 250, 320);
  g.fillStyle = '#9aa3b0';
  g.beginPath();
  g.arc(161, 240, 62, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(161, 410, 105, 85, 0, Math.PI, 0);
  g.fill();

  const x = 320;
  let y = 140;
  const row = (label, value, size = 30) => {
    g.fillStyle = '#5a6475';
    g.font = '18px Arial';
    g.fillText(label, x, y);
    g.fillStyle = '#111827';
    g.font = `bold ${size}px Arial`;
    g.fillText(value, x + 92, y);
    y += size + 16;
  };
  row('4d DLN', p.number, 32);
  row('1', p.last);
  row('2', `${p.first}${p.middle ? ' ' + p.middle : ''}`);
  row('8', p.address, 20);
  y += 4;
  const pair = (l1, v1, l2, v2) => {
    g.fillStyle = '#5a6475';
    g.font = '18px Arial';
    g.fillText(l1, x, y);
    g.fillText(l2, x + 330, y);
    g.fillStyle = p.redDates && (l1 === '4b EXP' || l2 === '4b EXP') ? '#b3261e' : '#111827';
    g.font = 'bold 28px Arial';
    g.fillText(v1, x + 92, y);
    g.fillText(v2, x + 430, y);
    y += 46;
  };
  pair('3 DOB', p.dob, '4a ISS', p.iss);
  pair('4b EXP', p.exp, '9 CLASS', p.cls);
  pair('9a END', p.end, '12 REST', p.rest);
  pair('15 SEX', p.sex, '16 HGT', p.hgt);
  g.fillStyle = '#5a6475';
  g.font = 'italic 34px Georgia';
  g.fillText(`${p.first} ${p.last}`.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase()), 40, 520);
  g.font = '16px Arial';
  g.fillText('Fictional demo card generated for NeWay TMS. Every value on it is made up.', 40, 600);

  // Watermark.
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-0.35);
  g.fillStyle = 'rgba(179,38,30,0.13)';
  g.font = 'bold 150px Arial';
  g.textAlign = 'center';
  g.fillText('SAMPLE', 0, 50);
  g.restore();
  return c;
}

/** A "phone photo" of a card: on a desk, slightly rotated, dimmer, with noise. */
function photographed(card, W = 1280, H = 900) {
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#6b5a48';
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-0.07);
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 30;
  g.globalAlpha = 0.93;
  const k = Math.min((W * 0.86) / card.width, (H * 0.9) / card.height, 1);
  g.drawImage(card, (-card.width * k) / 2, (-card.height * k) / 2, card.width * k, card.height * k);
  g.restore();
  const img = g.getImageData(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 38;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] * 0.88 + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] * 0.86 + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] * 0.8 + n));
  }
  g.putImageData(img, 0, 0);
  return c;
}

const cdls = [
  {
    file: 'cdl-sample-jordan-sampleton.png',
    kind: 'png',
    stateName: 'ILLINOIS (SAMPLE)',
    tint: ['#dfe9f5', '#f4efe2'],
    number: 'S530-4412-8890',
    last: 'SAMPLETON',
    first: 'JORDAN',
    middle: 'LEE',
    address: '1234 EXAMPLE AVE, SPRINGFIELD, IL 62701',
    dob: '03/14/1988',
    iss: '06/01/2024',
    exp: '06/01/2028',
    cls: 'A',
    end: 'N T',
    rest: 'L',
    sex: 'M',
    hgt: "5'-11\"",
    truth: {
      legalFirstName: 'JORDAN', legalMiddleName: 'LEE', legalLastName: 'SAMPLETON', dateOfBirth: '1988-03-14',
      cdlNumber: 'S530-4412-8890', issuingState: 'IL', cdlClass: 'A', endorsements: ['N', 'T'], restrictions: ['L'],
      cdlIssuedOn: '2024-06-01', cdlExpiresOn: '2028-06-01',
    },
  },
  {
    file: 'cdl-sample-alex-rivera-photo.jpg',
    kind: 'photo',
    stateName: 'TEXAS (SAMPLE)',
    tint: ['#f3e4d8', '#e6eef0'],
    number: '90817264',
    last: 'RIVERA-DEMO',
    first: 'ALEX',
    middle: 'M',
    address: '77 PLACEHOLDER LN, AUSTIN, TX 78701',
    dob: '11/02/1979',
    iss: '10/15/2018',
    exp: '10/15/2026',
    cls: 'B',
    end: 'NONE',
    rest: 'NONE',
    sex: 'F',
    hgt: "5'-06\"",
    redDates: true,
    truth: {
      legalFirstName: 'ALEX', legalMiddleName: 'M', legalLastName: 'RIVERA-DEMO', dateOfBirth: '1979-11-02',
      cdlNumber: '90817264', issuingState: 'TX', cdlClass: 'B', endorsements: [], restrictions: [],
      cdlIssuedOn: '2018-10-15', cdlExpiresOn: '2026-10-15',
    },
  },
];

const truth = { cdl: {}, rc: {} };
for (const p of cdls) {
  const card = cdlCard(p);
  if (p.kind === 'png') writeFileSync(join(OUT, p.file), card.toBuffer('image/png'));
  else writeFileSync(join(OUT, p.file), photographed(card).toBuffer('image/jpeg', 82));
  truth.cdl[p.file] = p.truth;
}
// The first card as a one-page PDF too, to prove the PDF path.
{
  const card = cdlCard(cdls[0]);
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(card.toBuffer('image/png'));
  const page = doc.addPage([612, 792]);
  page.drawImage(png, { x: 50, y: 400, width: 506, height: 319 });
  page.drawText('Scanned copy - SAMPLE', { x: 50, y: 380, size: 10, font: await doc.embedFont(StandardFonts.Helvetica) });
  const name = 'cdl-sample-jordan-sampleton.pdf';
  writeFileSync(join(OUT, name), await doc.save());
  truth.cdl[name] = cdls[0].truth;
}

// ------------------------------------------------------------------------------------ RCs
const CARRIER = { name: 'NeWay Demo Carrier LLC', mc: '100200', dot: '3004005' };

/** Draws an RC with PDF coordinates (origin bottom-left, 612 x 792) on a PDF page or a canvas. */
async function pdfDrawer() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  const col = (c) => rgb(c[0], c[1], c[2]);
  return {
    text: (s, x, y, size, bold, c) => page.drawText(s, { x, y, size, font: bold ? b : f, color: col(c) }),
    rect: (x, y, w, h, fill, border) =>
      page.drawRectangle({ x, y, width: w, height: h, ...(fill ? { color: col(fill) } : {}), ...(border ? { borderColor: col(border), borderWidth: 0.8 } : {}) }),
    watermark: () => page.drawText('SAMPLE', { x: 150, y: 330, size: 130, font: b, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(30) }),
    done: () => doc.save(),
  };
}

function canvasDrawer(scale = 2) {
  const c = createCanvas(612 * scale, 792 * scale);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  const css = (k) => `rgb(${Math.round(k[0] * 255)},${Math.round(k[1] * 255)},${Math.round(k[2] * 255)})`;
  return {
    text: (s, x, y, size, bold, k) => {
      g.fillStyle = css(k);
      g.font = `${bold ? 'bold ' : ''}${size * scale}px Arial`;
      g.fillText(s, x * scale, (792 - y) * scale);
    },
    rect: (x, y, w, h, fill, border) => {
      const top = (792 - y - h) * scale;
      if (fill) {
        g.fillStyle = css(fill);
        g.fillRect(x * scale, top, w * scale, h * scale);
      }
      if (border) {
        g.strokeStyle = css(border);
        g.lineWidth = 0.8 * scale;
        g.strokeRect(x * scale, top, w * scale, h * scale);
      }
    },
    watermark: () => {
      g.save();
      g.translate(150 * scale, (792 - 330) * scale);
      g.rotate(-Math.PI / 6);
      g.fillStyle = 'rgba(217,51,51,0.12)';
      g.font = `bold ${130 * scale}px Arial`;
      g.fillText('SAMPLE', 0, 0);
      g.restore();
    },
    done: () => c,
  };
}

async function rcPdf(rc, drawer) {
  const d = drawer ?? (await pdfDrawer());
  let y = 750;
  const f = false;
  const b = true;
  const rgb = (r, gg, bb) => [r, gg, bb];
  const t = (s, x, size = 9, font = f, color = rgb(0.1, 0.1, 0.12)) => d.text(s, x, y, size, font, color);
  const page = {
    drawRectangle: (o) => d.rect(o.x, o.y, o.width, o.height, o.color ?? null, o.borderColor ?? null),
  };
  d.watermark();
  t(rc.broker.name, 40, 16, b);
  t('RATE CONFIRMATION', 400, 13, b);
  y -= 14;
  t(`${rc.broker.address}  ·  MC# ${rc.broker.mc}  ·  ${rc.broker.phone}`, 40, 8);
  y -= 12;
  t('SAMPLE DOCUMENT FOR A SOFTWARE DEMO - NOT A REAL LOAD', 40, 8, b, rgb(0.7, 0.15, 0.15));
  y -= 24;
  t(`${rc.loadLabel}: ${rc.loadNumber}`, 40, 11, b);
  t(`Date: ${rc.issued}`, 400, 9);
  y -= 22;
  page.drawRectangle({ x: 36, y: y - 50, width: 540, height: 62, borderColor: rgb(0.6, 0.6, 0.65) });
  t('CARRIER', 44, 9, b);
  y -= 14;
  t(`${CARRIER.name}   MC# ${CARRIER.mc}   DOT# ${CARRIER.dot}`, 44);
  y -= 12;
  t('Driver: (to be assigned)   Truck: ____   Trailer: ____   Dispatch: 555-0100', 44);
  y -= 34;
  t('EQUIPMENT', 40, 9, b);
  t(rc.equipmentText, 130);
  y -= 13;
  t('COMMODITY', 40, 9, b);
  t(rc.commodity, 130);
  y -= 13;
  t('WEIGHT', 40, 9, b);
  t(rc.weightText, 130);
  if (rc.temperature) {
    y -= 13;
    t('TEMPERATURE', 40, 9, b);
    t(rc.temperature, 130);
  }
  y -= 13;
  t('MILES', 40, 9, b);
  t(rc.milesText, 130);
  y -= 13;
  t('HAZMAT', 40, 9, b);
  t(rc.hazmat ? 'YES' : 'NO', 130);
  y -= 24;
  rc.stops.forEach((s, i) => {
    page.drawRectangle({ x: 36, y: y - 58, width: 540, height: 70, color: rgb(0.95, 0.96, 0.97) });
    t(`STOP ${i + 1} - ${s.kind === 'pickup' ? 'PICKUP' : 'DELIVERY'}`, 44, 10, b);
    t(`${s.refLabel}: ${s.reference ?? '-'}`, 380, 9, b);
    y -= 14;
    t(s.facilityName, 44, 10);
    y -= 12;
    t(`${s.street ? s.street + ', ' : ''}${s.city}, ${s.state} ${s.zip}`, 44);
    y -= 12;
    t(`Appointment: ${s.apptText}`, 44);
    y -= 32;
  });
  y -= 4;
  t('RATE', 40, 11, b);
  y -= 14;
  for (const [label, amount] of rc.lines) {
    t(label, 44);
    t(amount, 260);
    y -= 12;
  }
  t('TOTAL CARRIER PAY', 44, 10, b);
  t(rc.totalText, 260, 10, b);
  y -= 24;
  t('NOTES', 40, 9, b);
  for (const line of rc.noteLines) {
    y -= 12;
    t(line, 44, 8);
  }
  y -= 18;
  t('Terms: carrier agrees to the broker-carrier agreement on file. This sample has no legal effect.', 40, 7, f, rgb(0.4, 0.4, 0.45));
  return d.done();
}

const rcs = [
  {
    file: 'rc-sample-1-demo-freight.pdf',
    broker: { name: 'Demo Freight Brokerage LLC', address: '400 Sample Blvd, Suite 9, Chicago, IL 60601', mc: '990011', phone: '555-0101' },
    loadLabel: 'Load #', loadNumber: 'DFB-240117', issued: '11/03/2026',
    equipmentText: "53' Dry Van", commodity: 'Paper products', weightText: '38,000 lbs', milesText: '812', hazmat: false,
    stops: [
      { kind: 'pickup', facilityName: 'Example Paper Mill', street: '100 Mill Road', city: 'Springfield', state: 'IL', zip: '62701', apptText: '11/10/2026 08:00', refLabel: 'PU #', reference: 'PU-55120' },
      { kind: 'delivery', facilityName: 'Sample Distribution Center', street: '2500 Commerce Pkwy', city: 'Columbus', state: 'OH', zip: '43215', apptText: '11/11/2026 07:00 - 11:00', refLabel: 'DEL #', reference: 'D-88341' },
    ],
    lines: [['Linehaul', '$2,600.00'], ['Fuel surcharge', '$250.00']], totalText: '$2,850.00',
    noteLines: ['Tracking via the DemoTrack app is required; $100 fine if tracking is off.', 'Send signed BOL and POD within 24 hours of delivery.'],
    truth: {
      brokerName: 'Demo Freight Brokerage LLC', brokerMc: '990011', brokerLoadNumber: 'DFB-240117', totalRate: 2850, linehaulRate: 2600,
      commodity: 'Paper products', weightLbs: 38000, equipment: 'dry_van', hazmat: false, temperature: null, miles: 812,
      stops: [
        { kind: 'pickup', facilityName: 'Example Paper Mill', street: '100 Mill Road', city: 'Springfield', state: 'IL', zip: '62701', date: '2026-11-10', time: '08:00', endTime: null, reference: 'PU-55120' },
        { kind: 'delivery', facilityName: 'Sample Distribution Center', street: '2500 Commerce Pkwy', city: 'Columbus', state: 'OH', zip: '43215', date: '2026-11-11', time: '07:00', endTime: '11:00', reference: 'D-88341' },
      ],
    },
  },
  {
    file: 'rc-sample-2-example-logistics-reefer.pdf',
    broker: { name: 'Example Logistics Partners Inc', address: '18 Placeholder Way, Atlanta, GA 30303', mc: '880022', phone: '555-0102' },
    loadLabel: 'Order No', loadNumber: '77812-A', issued: '11/02/2026',
    equipmentText: "53' Reefer", commodity: 'Frozen vegetables', weightText: '41,280.50 lb', milesText: '1,046', hazmat: false,
    temperature: '-5°F continuous',
    stops: [
      { kind: 'pickup', facilityName: 'Demo Cold Storage', street: '9 Icebox Ct', city: 'Fresno', state: 'CA', zip: '93721', apptText: '11/12/2026 1:00PM - 2:30PM', refLabel: 'PO', reference: 'PO-4471' },
      { kind: 'delivery', facilityName: 'Sample Grocers DC #12', street: '700 Market St', city: 'Phoenix', state: 'AZ', zip: '85004', apptText: '11/13/2026 23:30', refLabel: 'Appt #', reference: 'A-3302' },
      { kind: 'delivery', facilityName: 'Sample Grocers DC #19', street: '15 Desert Loop', city: 'Tucson', state: 'AZ', zip: '85701', apptText: '11/14/2026 06:00', refLabel: 'Appt #', reference: 'A-3319' },
    ],
    lines: [['Line haul', '$3,800.00'], ['Stop off', '$150.00'], ['Fuel', '$175.50']], totalText: '$4,125.50',
    noteLines: ['Reefer must run continuous at -5°F; download required on delivery.', 'Detention $50/hr after 2 free hours with in/out times on the BOL.'],
    truth: {
      brokerName: 'Example Logistics Partners Inc', brokerMc: '880022', brokerLoadNumber: '77812-A', totalRate: 4125.5, linehaulRate: 3800,
      commodity: 'Frozen vegetables', weightLbs: 41280.5, equipment: 'reefer', hazmat: false, temperature: '-5°F continuous', miles: 1046,
      stops: [
        { kind: 'pickup', facilityName: 'Demo Cold Storage', street: '9 Icebox Ct', city: 'Fresno', state: 'CA', zip: '93721', date: '2026-11-12', time: '13:00', endTime: '14:30', reference: 'PO-4471' },
        { kind: 'delivery', facilityName: 'Sample Grocers DC #12', street: '700 Market St', city: 'Phoenix', state: 'AZ', zip: '85004', date: '2026-11-13', time: '23:30', endTime: null, reference: 'A-3302' },
        { kind: 'delivery', facilityName: 'Sample Grocers DC #19', street: '15 Desert Loop', city: 'Tucson', state: 'AZ', zip: '85701', date: '2026-11-14', time: '06:00', endTime: null, reference: 'A-3319' },
      ],
    },
  },
  {
    file: 'rc-sample-3-sample-haul-flatbed.pdf',
    broker: { name: 'Sample Haul Network', address: '5 Fictional Ave, Dallas, TX 75201', mc: '770033', phone: '555-0103' },
    loadLabel: 'PRO #', loadNumber: '1112247', issued: '11/01/2026',
    equipmentText: "48' Flatbed (tarps required)", commodity: 'Steel coils', weightText: '44000', milesText: '389', hazmat: false,
    stops: [
      { kind: 'pickup', facilityName: 'Placeholder Steel Works', street: '1 Foundry Dr', city: 'Birmingham', state: 'AL', zip: '35203', apptText: '11/09/2026 08:00-14:00', refLabel: 'Release #', reference: 'R-9001' },
      { kind: 'delivery', facilityName: 'Demo Fabrication Yard', street: '', city: 'Memphis', state: 'TN', zip: '38103', apptText: '11/10/2026 FCFS', refLabel: 'DEL #', reference: null },
    ],
    lines: [['Flat rate', '$1,975.00']], totalText: '$1,975.00',
    noteLines: ['Driver must bring 6 tarps, 12 straps and edge protectors.', 'Late pickup fine $250.'],
    truth: {
      brokerName: 'Sample Haul Network', brokerMc: '770033', brokerLoadNumber: '1112247', totalRate: 1975, linehaulRate: null,
      commodity: 'Steel coils', weightLbs: 44000, equipment: 'flatbed', hazmat: false, temperature: null, miles: 389,
      stops: [
        { kind: 'pickup', facilityName: 'Placeholder Steel Works', street: '1 Foundry Dr', city: 'Birmingham', state: 'AL', zip: '35203', date: '2026-11-09', time: '08:00', endTime: '14:00', reference: 'R-9001' },
        { kind: 'delivery', facilityName: 'Demo Fabrication Yard', street: null, city: 'Memphis', state: 'TN', zip: '38103', date: '2026-11-10', time: null, endTime: null, reference: null },
      ],
    },
  },
];

for (const rc of rcs) {
  writeFileSync(join(OUT, rc.file), await rcPdf(rc));
  truth.rc[rc.file] = rc.truth;
}

// RC 3 as a phone photo (no text layer): the same layout drawn on a canvas, then "photographed".
{
  const canvas = await rcPdf(rcs[2], canvasDrawer(2));
  const photo = photographed(canvas, 1300, 1600);
  const name = 'rc-sample-3-sample-haul-flatbed-photo.jpg';
  writeFileSync(join(OUT, name), photo.toBuffer('image/jpeg', 80));
  truth.rc[name] = rcs[2].truth;
}

writeFileSync(join(OUT, 'truth.json'), JSON.stringify(truth, null, 2) + '\n');
console.log('samples written to', OUT);
