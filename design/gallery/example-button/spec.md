# ExampleButton

**Status:** Example scaffolding for Launchpad (DIDI-849 pattern demo; not a production design).

## Purpose

Primary actions and secondary dismiss actions in forms and dialogs.

## Anatomy

- One text label, centered in the control
- Optional disabled state (reduced opacity, no pointer interaction)

## Variants

| Variant   | Use                             |
| --------- | ------------------------------- |
| Primary   | Main action (e.g. Save, Submit) |
| Secondary | Cancel or low-emphasis action   |

## Props

| Prop       | Type                         | Default     | Notes                      |
| ---------- | ---------------------------- | ----------- | -------------------------- |
| `label`    | string                       | (required)  | Visible button text        |
| `variant`  | `"primary"` \| `"secondary"` | `"primary"` | Visual style               |
| `disabled` | boolean                      | `false`     | When true, not interactive |

## Accessibility

- Native `<button type="button">`
- Disabled state uses the `disabled` attribute

## QA checklist

- [ ] Primary and secondary match token colors in this spec (primary: `#1a56db`, secondary: outline on white)
- [ ] Disabled variant does not respond to click
- [ ] Label matches spec copy in each variant demo
