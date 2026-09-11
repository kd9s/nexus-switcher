## 2024-05-18 - Missing localized aria labels support
**Learning:** The application uses a custom localization system `data-i18n-*`, however it lacked support for `data-i18n-aria-label`. This made it impossible to have accessible, localized labels on icon-only interactive elements out-of-the-box.
**Action:** Always check the custom localization framework's implementation (e.g. `applyTranslations`) when needing to add accessible labels in a multi-language app, and extend the framework if needed rather than hardcoding static aria-labels.
