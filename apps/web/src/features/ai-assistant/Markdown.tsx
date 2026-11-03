import { Fragment, type ReactNode } from 'react';

/**
 * The small piece of Markdown NeWay AI writes: paragraphs, **bold**, *italic*, `code`, bullet and
 * numbered lists, ### headings and pipe tables. Built as React elements - never as HTML - so
 * nothing the model writes can run in the page.
 */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i]!.trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto rounded-[10px] border border-nw-border">
          <table className="w-full border-collapse text-xs">
            {head ? (
              <thead className="bg-nw-subtle">
                <tr>
                  {head.map((c, k) => (
                    <th key={k} className="whitespace-nowrap border-b border-nw-border px-3 py-1.5 text-left font-semibold text-nw-text-2">
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri} className="border-b border-nw-border last:border-b-0">
                  {r.map((c, k) => (
                    <td key={k} className="px-3 py-1.5 text-nw-text">
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <div key={blocks.length} className="font-bold text-nw-text">
          {inline(heading[1]!)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={blocks.length} className={`${ordered ? 'list-decimal' : 'list-disc'} flex flex-col gap-1 pl-5`}>
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(\||#{1,4}\s|[-*•]\s|\d+[.)]\s)/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={blocks.length}>
        {para.map((p, k) => (
          <Fragment key={k}>
            {k ? <br /> : null}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="flex flex-col gap-2 text-sm leading-relaxed text-nw-text">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={m.index} className="font-semibold">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index} className="rounded-sm bg-nw-subtle px-1 text-[12px]">{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
