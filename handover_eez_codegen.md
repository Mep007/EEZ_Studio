# EEZ Studio Codegen Handover

Date: 2026-07-05
Workspace: `C:\esp\tools\eez-studio-src`

## Why We Are Doing This

The firmware project `MESP604_ESP32P4_AstraGID` uses EEZ Studio to generate
LVGL screens. The generated code currently exposes many widgets through one
global `objects` structure. As pages, containers, panels, and dashboards grow,
this becomes painful:

- every object needs a globally unique name,
- generated object lists become hard to navigate,
- page-local UI logic is awkward because related widgets are not grouped,
- generated code creates all screens/objects eagerly, increasing RAM pressure,
- firmware-side fixes have to work around generated global names.

The idea is to investigate modifying EEZ Studio code generation in a
TouchGFX-like direction:

- group generated widgets by screen, container, and panel,
- keep object references in nested structs,
- reduce the need for globally unique object names,
- make generated C/C++ easier to use from firmware,
- later possibly enable more page-local/lazy creation strategies.

There is already a related upstream issue:

- `eez-open/studio` issue `#646`: "Separate objects struct by screen"

That issue proposes changing from one global object bag toward per-screen
object structs, which is close to our direction.

## Local Setup Done

Repository cloned:

```text
C:\esp\tools\eez-studio-src
```

Current cloned commit:

```text
dd4aae71
```

Node setup:

```text
C:\esp\tools\nodejs -> C:\esp\tools\node-v22.21.1-win-x64
node v22.21.1
npm  10.9.4
```

Visual Studio installed:

```text
Visual Studio Community 2026
VC tools path:
C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat
```

Build command that worked:

```bat
cd /d C:\esp\tools\eez-studio-src
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\esp\tools\nodejs;%PATH%
C:\esp\tools\nodejs\npm.cmd run build
```

Build result:

```text
npm run build: OK
build/main/main.js exists
```

## Important Toolchain Notes

Node 24 was tried first:

```text
node v24.18.0
npm  11.16.0
```

It failed on native dependency rebuilds. After patching VS2026 detection, it
progressed but then generated projects with:

```xml
<PlatformToolset>ClangCL</PlatformToolset>
```

and failed because the ClangCL VS component was not installed.

Node 22 LTS worked better and native rebuild succeeded:

```bat
C:\esp\tools\node-v22.21.1-win-x64\npm.cmd rebuild
```

Result:

```text
rebuilt dependencies successfully
```

## Local Patch Applied In node_modules

Current `@electron/node-gyp` does not recognize Visual Studio 2026 / version 18.
It only knows VS 2017, 2019, and 2022.

A temporary local patch was applied in:

```text
node_modules\@electron\node-gyp\lib\find-visualstudio.js
```

Patch intent:

- include `2026` in supported VS years,
- map Visual Studio major version `18` to `2026`,
- map VS2026 toolset to `v145`.

This patch is inside `node_modules`, so it is not durable. A clean
`npm install` can erase it. If we keep using VS2026, make this repeatable with
a small helper script or use a proper patch mechanism. Alternative: install
VS2022 Build Tools side-by-side and avoid the VS2026 detection problem.

## Current Git State In EEZ Clone

Tracked change currently visible:

```text
M package-lock.json
```

Observed diff:

```text
version 0.27.0 -> 0.28.0
```

This appears to be npm synchronizing the root package version with
`package.json`. No dependency changes were observed in the quick diff.

`node_modules` and `build` are local generated artifacts.

## Next Investigation Direction

Start by locating the LVGL code generator for generated `objects` and screen
creation output. Search terms:

```bat
rg "objects" packages
rg "typedef struct" packages\project-editor
rg "create_screen" packages\project-editor
rg "lv_obj_t" packages\project-editor
rg "screens_t" packages\project-editor
```

Likely areas:

```text
packages\project-editor
packages\project-editor\lvgl
```

The first goal should be read-only exploration:

1. Find where `screens.h`, `screens.c`, and `objects` are generated.
2. Identify the model objects available to the generator: screen, container,
   panel, widget name, parent relation.
3. Sketch a minimally invasive generated structure, probably starting with
   per-screen object grouping before deeper container/panel nesting.
4. Generate a tiny EEZ sample project and compare output before/after.

Suggested first generated C shape to aim for:

```c
typedef struct {
    lv_obj_t *button_1;
    lv_obj_t *label_1;
} main_screen_objects_t;

typedef struct {
    lv_obj_t *bar_1;
    lv_obj_t *value_label;
} dash2_panel_1_objects_t;

typedef struct {
    dash2_panel_1_objects_t panel_1;
} dash2_screen_objects_t;

typedef struct {
    main_screen_objects_t main;
    dash2_screen_objects_t dash2;
} screens_t;

extern screens_t screens;
```

For backwards compatibility, consider whether EEZ needs an option such as:

```text
Generate flat global objects struct
Generate nested screen/container objects struct
```

## Practical Reminder

When opening the EEZ repo in VS Code, prefer a terminal initialized like this:

```bat
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\esp\tools\nodejs;%PATH%
```

Then:

```bat
npm.cmd run build
npm.cmd start
```

Use `npm.cmd`, not plain `npm` in PowerShell, because PowerShell can block
`npm.ps1` via execution policy.
