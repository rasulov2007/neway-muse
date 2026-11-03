import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuItem } from '../DropdownMenu';
import { DataTable } from './DataTable';
import { createColumns } from './features';
import { createDataTableState } from './useDataTableState';
import { clearRecentlyCreated, markCreated } from '@/lib/recent-creates';

interface Truck {
  id: string;
  unit: string;
  miles: number;
  status: string;
}

function makeTrucks(count: number): Truck[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    unit: `Unit ${String(i + 1).padStart(4, '0')}`,
    miles: (i + 1) * 1000,
    status: i % 2 ? 'active' : 'in_shop',
  }));
}

const trucks = makeTrucks(30);
const col = createColumns<Truck>();
const columns = col.columns([
  col.accessor('unit', { header: 'Unit', meta: { primary: true } }),
  col.accessor('miles', { header: 'Miles', meta: { align: 'right' } }),
  col.accessor('status', { header: 'Status', enableSorting: false }),
]);
const rowKey = (row: Truck) => row.id;

describe('DataTable', () => {
  it('renders table semantics with a caption and sortable column headers', () => {
    render(<DataTable columns={columns} data={trucks} rowKey={rowKey} caption="Trucks" />);
    expect(screen.getByRole('table', { name: 'Trucks' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Unit/ })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('columnheader', { name: /Unit/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Status' })).not.toHaveAttribute('aria-sort');
  });

  it('toggles aria-sort and reports sorting through onStateChange', async () => {
    const user = userEvent.setup();
    const onStateChange = vi.fn();
    render(
      <DataTable columns={columns} data={trucks} rowKey={rowKey} onStateChange={onStateChange} />,
    );
    const header = screen.getByRole('columnheader', { name: /Unit/ });
    await user.click(within(header).getByRole('button', { name: 'Unit' }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(onStateChange).toHaveBeenLastCalledWith({ sorting: [{ id: 'unit', desc: false }] });

    await user.click(within(header).getByRole('button', { name: 'Unit' }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(onStateChange).toHaveBeenLastCalledWith({ sorting: [{ id: 'unit', desc: true }] });
  });

  it('selects rows: header checkbox goes indeterminate, then all, and the bulk bar appears', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={trucks}
        rowKey={rowKey}
        selectable
        bulkActions={(rows) => <button type="button">Assign {rows.length}</button>}
      />,
    );
    const selectAll = screen.getByRole('checkbox', { name: 'Select all rows on this page' });
    expect(selectAll).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }));
    expect(selectAll).toHaveAttribute('aria-checked', 'mixed');
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('1 selected');
    expect(within(bar).getByRole('button', { name: 'Assign 1' })).toBeInTheDocument();

    await user.click(selectAll);
    expect(selectAll).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toHaveTextContent('25 selected');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).not.toBeInTheDocument();
    expect(selectAll).toHaveAttribute('aria-checked', 'false');
  });

  it('paginates with range text and disabled bounds', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={trucks} rowKey={rowKey} />);
    expect(screen.getByText('1–25 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('26–30 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByText('Unit 0030')).toBeInTheDocument();
  });

  it('uses the server total and does not paginate client-side when serverSide', () => {
    render(
      <DataTable
        columns={columns}
        data={trucks.slice(0, 5)}
        rowKey={rowKey}
        total={377}
        state={createDataTableState({ pagination: { page: 2, pageSize: 25 } })}
        onStateChange={() => {}}
      />,
    );
    expect(screen.getByText('26–50 of 377')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(6);
  });

  it('renders loading, empty and error states', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(
      <DataTable columns={columns} data={trucks} rowKey={rowKey} loading />,
    );
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Unit/ })).toBeInTheDocument();

    rerender(<DataTable columns={columns} data={[]} rowKey={rowKey} emptyTitle="No trucks yet" />);
    expect(screen.getByRole('heading', { name: 'No trucks yet' })).toBeInTheDocument();

    rerender(
      <DataTable
        columns={columns}
        data={[]}
        rowKey={rowKey}
        error={new Error('boom')}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('activates rows by click and Enter, ignoring clicks on row actions', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onEdit = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={trucks}
        rowKey={rowKey}
        onRowClick={onRowClick}
        rowActions={(row) => <MenuItem onSelect={() => onEdit(row.id)}>Edit</MenuItem>}
      />,
    );
    await user.click(screen.getByText('Unit 0001'));
    expect(onRowClick).toHaveBeenCalledWith(trucks[0]);

    const secondRow = screen.getAllByRole('row')[2]!;
    expect(secondRow).toHaveAttribute('tabindex', '0');
    secondRow.focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(trucks[1]);

    await user.click(screen.getAllByRole('button', { name: 'Row actions' })[0]!);
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('t1');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('hides a column from the column chooser', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={trucks} rowKey={rowKey} />);
    expect(screen.getByRole('columnheader', { name: /Miles/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Miles' }));
    expect(screen.queryByRole('columnheader', { name: /Miles/ })).not.toBeInTheDocument();
  });

  it('virtualizes a large page and renders only a window of rows', () => {
    // jsdom has no layout: give the scroll container a viewport and each row a height.
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.virtualized) return 400;
        return this.tagName === 'TR' ? 40 : 0;
      });
    const many = makeTrucks(1000);
    render(
      <DataTable
        columns={columns}
        data={many}
        rowKey={rowKey}
        virtualize
        showColumnChooser={false}
        state={createDataTableState({ pagination: { page: 1, pageSize: 1000 } })}
        onStateChange={() => {}}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThan(200);
    expect(screen.getByText('1–1,000 of 1,000')).toBeInTheDocument();
    offsetHeight.mockRestore();
  });

  it('filters client-side with globalFilter and renders toolbar slots', () => {
    const onExport = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={trucks}
        rowKey={rowKey}
        toolbar={<span>Toolbar</span>}
        onExport={onExport}
        state={createDataTableState({ globalFilter: '0003' })}
        onStateChange={() => {}}
      />,
    );
    expect(screen.getByText('Toolbar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('Unit 0003')).toBeInTheDocument();
    expect(screen.queryByText('Unit 0001')).not.toBeInTheDocument();
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
  });
});

describe('the just-created outline', () => {
  it('outlines the row a person has only just created, and nothing else', async () => {
    clearRecentlyCreated();
    const columns = createColumns<Truck>().columns([
      createColumns<Truck>().accessor('unit', { header: 'Unit' }),
    ]);

    render(<DataTable data={trucks.slice(0, 3)} columns={columns} rowKey={(row) => row.id} />);

    markCreated('t2');
    const created = await screen.findByText('Unit 0002');
    const row = created.closest('tr');
    expect(row?.className).toContain('outline-nw-done-icon');

    const other = screen.getByText('Unit 0001').closest('tr');
    expect(other?.className ?? '').not.toContain('outline-nw-done-icon');

    clearRecentlyCreated();
  });
});
