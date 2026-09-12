## 2024-05-18 - Missing ARIA Labels on Color Buttons
**Learning:** Icon-only and color-only buttons throughout the app are missing `aria-label` attributes, making them inaccessible to screen readers. For color buttons, we need localized ARIA labels.
**Action:** Add localized `data-i18n-aria-label` to theme color buttons, and `aria-label` where standard labels suffice.
