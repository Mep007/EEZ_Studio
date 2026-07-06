# MEP Fork Changes

This fork adds an experimental LVGL code generation mode for projects that use
many repeated UI blocks, such as dashboard tiles.

## Main Feature

Added a build option:

```text
Settings > Build > Nested object structs (experimental)
```

When enabled, generated LVGL object references are grouped into nested C structs
instead of one flat global `objects` namespace.

## Why

In the default EEZ Studio output, every referenced LVGL widget needs a globally
unique name. This becomes awkward when the UI contains repeated containers with
the same internal structure.

This fork allows repeated containers to reuse the same local child names.

Example:

```c
objects.dash_demo_2.live_data_1.value
objects.dash_demo_2.live_data_2.value
objects.dash_demo_2.live_data_3.value
```

Each `live_data_*` container can contain local fields such as:

```text
icon, label, units, min, max, value, bar
```

## Generated Struct Model

Named LVGL widgets with children become nested struct nodes.

The widget's own LVGL object pointer is stored as `.obj`.

Example:

```c
objects.main.panel_1.tile_1.obj
objects.main.panel_1.tile_1.value
objects.main.panel_1.tile_1.bar
objects.main.panel_1.tile_1.button.obj
objects.main.panel_1.tile_1.button.label
```

## Additional Changes

- LVGL identifier uniqueness is scoped to the generated struct owner when the
  experimental mode is enabled.
- New/copied widgets inside a named parent can use local identifiers.
- The LVGL wizard assigns identifiers to default template widgets.
- Theme/style code generation uses the correct nested object paths.
- Screen invalidation uses the correct nested root screen pointer.
- LVGL widget context menu has `Copy generated object path`.
- Properties > General shows a read-only `Generated object path`.
- App title includes `MEP FORK - EEZ Studio` to make the fork visible while
  testing.
- `run-eez-studio-dev.bat` starts the local Electron build from the repo root.

## Default Behavior

The official flat output remains the default.

The nested struct output is only used when:

```text
Nested object structs (experimental) = enabled
```

## Validation

Validated with:

```text
npm run build-src
```

Result:

```text
TypeScript build OK
Gulp release build OK
```

