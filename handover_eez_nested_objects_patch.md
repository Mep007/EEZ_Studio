# EEZ Studio MEP Fork - Nested Objects Patch Handover

Date: 2026-07-05
Branch: `mesp-lvgl-codegen`

## Goal

Implement an experimental LVGL codegen mode where generated object references
are grouped into nested C structs instead of one flat object namespace.

The concrete use case is repeated dashboard tiles in an LVGL firmware project:

```text
Dash_demo_2_Value_cont_1
Dash_demo_2_Value_cont_2
Dash_demo_2_Value_cont_3
Dash_demo_2_Value_cont_4
Dash_demo_2_Value_cont_5
```

Each tile should be able to use the same local child names:

```text
icon, lbl, units, min, max, value, bar
```

Generated C access should then look like:

```c
objects.dash_demo_2.dash_demo_2_value_cont_1.lbl
objects.dash_demo_2.dash_demo_2_value_cont_2.lbl
```

instead of requiring globally unique child names.

## Feature Flag

Added experimental build setting:

```text
Settings > Build > Nested object structs (experimental)
```

Project setting key:

```ts
project.settings.build.screenObjectStructs
```

Default is `false`, so the official flat generated output remains the default
unless this option is enabled.

Main file:

```text
packages/project-editor/project/project.tsx
```

## Codegen Behavior

Main implementation is in:

```text
packages/project-editor/lvgl/build.ts
```

When `screenObjectStructs` is enabled:

- `objects_t` contains per-screen structs.
- A named LVGL widget with children becomes a nested struct node.
- The actual LVGL object pointer for such a node is stored as `.obj`.
- Child widgets become fields under that node.
- This is generic for LVGL object hierarchy, not limited to Container/Panel.

Example generated output:

```c
typedef struct _main_main_panel_1_main_mep_cont_1_button_objects_t {
    lv_obj_t *obj;
    lv_obj_t *label;
} main_main_panel_1_main_mep_cont_1_button_objects_t;

typedef struct _main_main_panel_1_main_mep_cont_1_objects_t {
    lv_obj_t *obj;
    lv_obj_t *label;
    lv_obj_t *label_1;
    lv_obj_t *label_2;
    lv_obj_t *bar;
    main_main_panel_1_main_mep_cont_1_button_objects_t button;
} main_main_panel_1_main_mep_cont_1_objects_t;
```

And access:

```c
objects.main.main_panel_1.main_mep_cont_1.button.obj
objects.main.main_panel_1.main_mep_cont_1.button.label
```

The generator also tracks field names per generated struct and avoids duplicate
C fields inside the same struct.

## Auto Naming / Duplicate Scope

Main implementation:

```text
packages/project-editor/store/commands.ts
packages/project-editor/lvgl/widgets/Base.tsx
```

In the experimental mode:

- Direct screen children still get page-prefixed generated identifiers.
- Children inside a named struct parent can use local names such as `label`,
  `bar`, `button`, `icon`, `lbl`.
- Duplicate checks use the generated object struct scope, not only global scope.
- Copying repeated containers can keep the same local child names inside each
  copied container.

This allows repeated tile/container patterns while still catching real
collisions inside the same generated C struct.

## Wizard / New Project Naming

Main implementation:

```text
packages/project-editor/project/ui/Wizard.tsx
```

The LVGL project wizard now assigns missing LVGL widget identifiers in default
templates. This fixed the default "Hello, world!" label not getting an initial
identifier in newly created LVGL projects.

## MEP Fork Marker / Runner

MEP fork is made visually obvious in the running app:

```text
packages/main/util.ts
packages/home/tabs-store.tsx
```

The title now contains:

```text
MEP FORK - EEZ Studio
```

Added local helper runner:

```text
run-eez-studio-dev.bat
```

It starts Electron from the repo and clears `ELECTRON_RUN_AS_NODE`, which had
previously caused Electron to run as Node instead of starting the app.

## Verification Done

Build command used:

```powershell
npm run build-src
```

Result:

```text
tsc OK
gulp release OK
```

Verified on a small local LVGL test project.

Generated output confirmed:

- nested structs in `src/ui/screens.h`
- nested object assignments in `src/ui/screens.c`
- theme color applied to deeply nested `button.label`
- no duplicate fields in generated structs

Verified on a real firmware project with repeated dashboard tiles.

The generated files:

```text
main/ui/screens.h
main/ui/screens.c
```

contain expected local tile fields:

```c
lv_obj_t *obj;
lv_obj_t *icon;
lv_obj_t *lbl;
lv_obj_t *units;
lv_obj_t *min;
lv_obj_t *max;
lv_obj_t *value;
lv_obj_t *bar;
```

for all five `Dash_demo_2_Value_cont_*` structs.

Theme code also generated correct nested references, for example:

```c
lv_obj_set_style_text_color(objects.dash_demo_2.dash_demo_2_value_cont_1.lbl, ...);
lv_obj_set_style_text_color(objects.dash_demo_2.dash_demo_2_value_cont_2.lbl, ...);
```

Checked `screens.h` for duplicate fields: none found.

Additional fix after firmware project review:

- theme invalidation originally still generated flat screen references such as
  `lv_obj_invalidate(objects.main)`
- in nested mode the root screen pointer is now addressed via the generated
  accessor, e.g. `objects.main.main`
- fixed generator to call `getLvglObjectAccessor(page.lvglScreenWidget!)` for
  page invalidation, so flat and nested modes both use the correct root pointer

Developer convenience added:

- LVGL widget tree context menu now has `Copy generated object path`
- this copies the generated C accessor for the selected widget, for example
  `objects.dash_demo_2.dash_demo_2_value_cont_1.value`
- for nested struct nodes it copies the `.obj` pointer, for example
  `objects.main.main_panel_1.main_mep_cont_1.button.obj`
- the same generated path is also shown read-only in Properties > General as
  `Generated object path`

## Known Limitations / Follow-up Ideas

- Generated struct type names are valid but long, e.g.
  `dash_demo_2_dash_demo_2_value_cont_1_objects_t`.
- The runtime LVGL allocation model is unchanged. This improves C access and
  naming, not ESP32 heap fragmentation.
- Existing action/reference UI may need more testing with duplicate local names
  in complex projects.
- User widget handling was not deeply tested.
- The feature is intentionally behind a build option because upstream-compatible
  flat output should remain default.

## Files Changed In EEZ Fork

Expected modified/untracked files at handover time:

```text
packages/home/tabs-store.tsx
packages/main/util.ts
packages/project-editor/lvgl/build.ts
packages/project-editor/lvgl/widgets/Base.tsx
packages/project-editor/project/project.tsx
packages/project-editor/project/ui/Wizard.tsx
packages/project-editor/store/commands.ts
run-eez-studio-dev.bat
handover_eez_nested_objects_patch.md
```

## Suggested Commit Message

```text
feat(lvgl): add experimental nested object structs
```

Possible longer body:

```text
Add a build option to generate LVGL object references as nested structs.
Named widgets with children become struct nodes with an .obj pointer, allowing
repeated containers to reuse local child names while keeping the flat output as
the default.

Also scope LVGL identifier uniqueness to the generated struct owner in this
mode, assign identifiers in LVGL wizard templates, and mark the local MEP fork
in the app title.
```
