# MEP Fork Changes

Current fork release: `MEP FORK v1.0.3`

The release is shown in the application title as:

```text
MEP FORK v1.0.3 - EEZ Studio
```

The fork version is defined once in:

```text
packages/eez-studio-shared/mep-fork.ts
```

## v1.0.3 - App/UI Bridge Code Generation

This release adds an optional, transport-neutral bridge between generated LVGL
UI code and application code.

### Bridge Generator

- Adds `Generate App/UI bridge` and related output, transport, queue and update
  settings under Build.
- Generates a portable UI engine and screen controller registry from the same
  screen identifiers used by the LVGL generator.
- Creates user-owned message contracts, screen controllers and APP command
  handlers only when they are missing.
- Generates CMake and Make source lists without editing firmware build files.

### Runtime And Transports

- Adds static multi-listener lifecycle and screen tick APIs while preserving the
  original single callback setters.
- Dispatches queued APP events only to the active screen controller from the
  existing LVGL tick context.
- Supports ESP-IDF FreeRTOS, standard FreeRTOS and CMSIS-RTOS2 queues.
- Provides a user-owned custom transport scaffold for other schedulers or
  bare-metal projects.
- Keeps queue operations nonblocking and exposes dropped/received counters.
- Forces `run-eez-studio-dev.bat` to use the local Electron binary and an
  isolated development profile, so it can run beside an installed EEZ Studio.

### Regeneration Safety

- Keeps generated files under `ui_app/generated` and tracks them in a separate
  `.eez-bridge-build` manifest.
- Never adds user-owned bridge files to orphan cleanup.
- Compares generated `UI_BRIDGE_API_VERSION` with the user-owned
  `UI_BRIDGE_USER_API_VERSION` and stops compilation when it is missing or
  incompatible.
- Uses containment, real-path and regular-file checks before generated writes
  or orphan deletion.
- Rejects unsafe manifest paths and warns about controllers left behind after a
  screen rename or removal.

### Validation

- TypeScript compilation and Gulp release build passed.
- Bridge-disabled and bridge-enabled MESP604 headless exports passed.
- Enabling the bridge did not change the standard generated UI files.
- Repeated export preserved a manually edited controller byte for byte.
- Renaming a screen updated the registry, created its new controller, retained
  the old controller and emitted an orphan warning.
- Unsafe orphan cleanup was rejected while a valid generated orphan was
  removed.
- Custom, ESP-IDF FreeRTOS, standard FreeRTOS and CMSIS-RTOS2 outputs passed
  ARM GCC C11 syntax checks with warnings treated as errors.
- Matching bridge API versions compiled, while mismatched and missing
  user-owned API versions were rejected by the generated headers.
- Generated `screens.c` passed ARM GCC syntax validation against LVGL.

Detailed implementation and integration notes are available in:

```text
handover_eez_app_ui_bridge_codegen.md
```

## v1.0.2 - Hierarchical Screen Runtime

This release makes generated LVGL screen handling safe for hierarchical object
structs and multi-screen projects.

### Migration Note For Custom Templates

Projects that override generated `ui.c` or `ui.h` must be migrated to the new
screen runtime API. Custom templates should call `ui_screens_init()`,
`ui_load_screen(SCREEN_ID_<FIRST_SCREEN>)` and `ui_screens_tick()` instead of
keeping private screen state or flat object lookups.

Remove legacy template code that uses:

```text
currentScreen
getLvglObjectFromIndex()
((lv_obj_t **)&objects)[index]
screen_id - 1 screen mapping
private loadScreen() / loadScreenAnim() implementations
```

A real ESP32 LVGL project with repeated dashboard tiles was migrated with this
template model after regeneration, so subsequent EEZ exports keep the new
runtime API instead of reintroducing the old flat screen handling.

### Screen Descriptors

- Generates an explicit descriptor table for screen IDs, root pointers, create
  functions and tick functions.
- Removes screen lookup through the unsafe
  `((lv_obj_t **)&objects)[index]` pattern.
- Removes `screenId - 1` indexing from generated screen create, delete and tick
  paths.
- Adds `SCREEN_ID_NONE`, `SCREEN_ID_COUNT` and `UI_SCREEN_COUNT`.

### Screen Runtime API

- Adds validated `ui_screen_get_root()` and `ui_screen_is_valid()` helpers.
- Tracks requested, loading and active screen IDs independently.
- Adds idempotent `ui_screens_init()` and active-screen `ui_screens_tick()`.
- Adds lifecycle callbacks for load start, loaded, unload start and unloaded.
- Adds an optional user tick callback that is never called with
  `SCREEN_ID_NONE`.

### Animated Screen Loading

- Adds `ui_load_screen_anim()` with animation type, duration and delay.
- Keeps `ui_load_screen()` as a default fade-in wrapper using 200 ms.
- Keeps `loadScreen()` and `loadScreenAnim()` compatibility wrappers.
- Keeps LVGL `auto_delete` fixed to `false` because generated screen pointers
  remain stored in `objects`.
- Generates the correct API names and animation types for LVGL 8 and LVGL 9.

### Theme Runtime API

- Adds `ui_theme_set()`, `ui_theme_get()` and `ui_theme_get_color()` for
  non-Flow LVGL projects.
- Allows selecting a theme before generated screen initialization.
- Keeps `change_color_theme()` as a compatibility wrapper.

### Validation

- TypeScript compilation passed.
- Gulp release build passed.
- DC502 headless EEZ export completed without project errors or warnings.
- Generated `screens.c` and `ui.c` passed ARM GCC syntax validation.
- A real ESP32 LVGL project regenerated successfully after its custom
  `ui.c`/`ui.h` templates were updated to the new runtime API.
- Windows source build and unsigned installer packaging were verified locally.

Detailed implementation and migration notes are available in:

```text
handover_eez_screen_runtime_codegen.md
```

## Existing Nested Object Feature

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
- App title includes the current `MEP FORK` release to make the fork and its
  generated-code compatibility level visible while testing.
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

