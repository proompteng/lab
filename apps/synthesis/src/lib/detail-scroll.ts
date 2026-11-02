type ScrollPosition = Pick<HTMLElement, 'scrollTop'>

export const resetDetailScrollToTop = (scrollContainer: ScrollPosition | null) => {
  if (!scrollContainer) return
  scrollContainer.scrollTop = 0
}
