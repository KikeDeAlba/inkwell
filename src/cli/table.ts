export interface Column {
  header: string
  align?: 'left' | 'right'
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, width - 1)}…`
}

export function renderTable(columns: Column[], rows: string[][], maxCellWidth = 48): string {
  const widths = columns.map((column, index) => {
    const cells = rows.map((row) => row[index] ?? '')
    const longest = Math.max(column.header.length, ...cells.map((cell) => cell.length), 0)
    return Math.min(longest, maxCellWidth)
  })

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0
        const value = truncate(cell, width)
        return columns[index]?.align === 'right' ? value.padStart(width) : value.padEnd(width)
      })
      .join('  ')
      .trimEnd()

  const header = renderRow(columns.map((column) => column.header))
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')

  return [header, separator, ...rows.map(renderRow)].join('\n')
}
