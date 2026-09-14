## 2025-02-18 - Missing ARIA Labels on Icon Buttons
**Learning:** Several interactive elements (such as view toggles, refresh buttons, and theme color pickers) relied solely on visual cues (icons or colors) without providing accessible text alternatives, making them difficult for screen reader users to understand.
**Action:** Added `aria-label` attributes to these icon-only buttons to ensure their purpose is clearly conveyed to assistive technologies, improving accessibility without requiring visual or CSS changes.
