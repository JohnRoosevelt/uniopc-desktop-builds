import { matchFlavours } from '@blocksuite/affine-shared/utils'

export { DualLinkIcon16 } from '@blocksuite/affine-components/icons'
export { NoteDisplayMode } from '@blocksuite/affine-model'
export {
  DocModeProvider,
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine-shared/services'
export { createButtonPopper, on, once } from '@blocksuite/affine-shared/utils'
export { scrollbarStyle } from '../../node_modules/@blocksuite/blocks/dist/_common/components/index.js'
export { EdgelessEditorBlockSpecs } from '../../node_modules/@blocksuite/blocks/dist/_specs/preset/edgeless-specs.js'
export { PageEditorBlockSpecs } from '../../node_modules/@blocksuite/blocks/dist/_specs/preset/page-specs.js'
export { EdgelessFrameManager } from '../../node_modules/@blocksuite/blocks/dist/root-block/edgeless/frame-manager.js'
export { EdgelessRootService } from '../../node_modules/@blocksuite/blocks/dist/root-block/edgeless/edgeless-root-service.js'

export const BlocksUtils = {
  matchFlavours,
}
