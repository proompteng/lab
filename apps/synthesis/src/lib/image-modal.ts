export type ImageModalState = {
  isOpen: boolean
  imageId: string | null
}

export type ImageModalAction = { type: 'open'; imageId: string } | { type: 'close' } | { type: 'escape'; key: string }

export const initialImageModalState: ImageModalState = { isOpen: false, imageId: null }

export const reduceImageModalState = (state: ImageModalState, action: ImageModalAction): ImageModalState => {
  if (action.type === 'open') return { isOpen: true, imageId: action.imageId }
  if (action.type === 'close') return initialImageModalState
  if (action.type === 'escape' && action.key === 'Escape') return initialImageModalState
  return state
}

export const imageModalCaptionId = (imageId: string) => `attachment-image-modal-caption-${imageId}`
export const imageModalTitleId = (imageId: string) => `attachment-image-modal-title-${imageId}`
