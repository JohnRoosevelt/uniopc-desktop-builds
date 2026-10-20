; Do not expose packaged implementation filenames in the installer UI.
; The progress bar remains visible, while the expandable file-details pane is hidden.
!macro NSIS_HOOK_PREINSTALL
  SetDetailsPrint none
!macroend
