// contentEditable search fields must stay single-line plain text.
// Rich paste otherwise inserts styled nodes and grows the control row.

export function getSearchFieldText(el: HTMLElement) {
  return (el.textContent ?? '').replace(/[\r\n]+/g, ' ')
}

export function handleSearchFieldPaste(event: {
  preventDefault: () => void
  clipboardData: DataTransfer | null
  currentTarget: EventTarget & HTMLElement
}) {
  event.preventDefault()
  const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/[\r\n]+/g, ' ')
  if (!document.execCommand('insertText', false, text)) {
    insertTextAtCaret(event.currentTarget, text)
  }
}

export function handleSearchFieldKeyDown(event: { key: string, preventDefault: () => void }) {
  if (event.key === 'Enter') event.preventDefault()
}

function insertTextAtCaret(el: HTMLElement, text: string) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
    el.append(document.createTextNode(text))
    return
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
