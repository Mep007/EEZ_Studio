# EEZ Studio MEP Fork v1.0.3

This release adds the first complete phase of optional App/UI bridge code
generation for LVGL projects. It builds on the hierarchical screen runtime
introduced in MEP Fork v1.0.2.

## Highlights

- Optional bidirectional `APP <-> UI` bridge generation.
- Portable generated UI engine and per-screen controller registry.
- Nonblocking queue backends for:
  - FreeRTOS with ESP-IDF includes
  - FreeRTOS with standard includes
  - CMSIS-RTOS2
  - Custom user-provided transport
- Static multi-listener APIs for screen lifecycle and screen ticks.
- User-owned message contracts, screen controllers and APP command handlers.
- Separate CMake and Make source lists.
- Dedicated and contained generated-file manifest.
- Compile-time compatibility checks between generated and user-owned bridge
  APIs.
- Visible application identity `MEP FORK v1.0.3`.

## Communication Model

UI callbacks do not execute application operations directly:

```text
LVGL action
    -> AppCmds_Post()
    -> UI-to-APP queue
    -> AppUiCommands_Process()
    -> application service
```

Application tasks do not modify LVGL objects directly:

```text
application task
    -> UiEvents_Post()
    -> APP-to-UI queue
    -> UiEngine_Tick() in LVGL context
    -> active screen controller
```

Queue operations are nonblocking. The generated API is intended for task
context; ISR-specific wrappers remain the responsibility of the firmware.

## Project Settings

The following options are available under LVGL Build settings:

```text
Generate App/UI bridge
App/UI bridge output folder
Application handler output folder
Bridge transport
Default screen update period
Generate missing user files
UI event queue length
APP command queue length
Maximum UI events per tick
```

The bridge is disabled by default and does not change the normal EEZ output
until explicitly enabled.

## Output Ownership

EEZ rewrites only files under:

```text
ui_app/generated/
```

This includes the UI engine, screen registry, selected transport backend,
configuration header, source lists and `.eez-bridge-build` manifest.

The following files are created only when missing and are never overwritten or
deleted:

```text
ui_app/contract/ui_messages.h
ui_app/screens/<screen>/<screen>_screen_controller.h
ui_app/screens/<screen>/<screen>_screen_controller.c
ui_app/platform/ui_message_bus.h
ui_app/platform/ui_message_bus.c
app/app_ui_commands.h
app/app_ui_commands.c
```

The platform files are created only for the Custom transport.

## API Compatibility

Generated bridge files define:

```c
#define UI_BRIDGE_API_VERSION 0x00010003U
```

The user-owned message contract defines:

```c
#define UI_BRIDGE_USER_API_VERSION 0x00010003U
```

Generated public headers compare both values. Compilation stops with `#error`
if the user-owned version is missing or incompatible.

An existing `ui_messages.h` created by an earlier phase 1 build is not modified
automatically. Add `UI_BRIDGE_USER_API_VERSION` manually before compiling the
newly generated bridge.

## Firmware Integration

1. Enable the bridge and select the platform transport.
2. Generate the EEZ project.
3. Add `ui_bridge_sources.cmake` or `ui_bridge_sources.mk` to the firmware
   build.
4. Call `UiEngine_Init()` and `UiEngine_Start()` after normal UI
   initialization.
5. Call `AppUiCommands_Process(max_commands)` from the APP task or main loop.
6. Add project-specific `APP_CMD_*` and `UI_EVENT_*` values to
   `ui_messages.h`.
7. Implement the generated screen controller scaffolds.

The generated engine is driven by the existing `ui_screens_tick()` path. It
does not create an additional LVGL timer.

## Regeneration Safety

- Standard EEZ build tracking does not contain bridge output.
- Only `ui_app/generated` files are listed in the bridge manifest.
- User-owned files are created with exclusive create semantics.
- Generated writes validate resolved parent paths and regular-file status.
- Orphan cleanup rejects absolute paths, `..` escapes and symlinks.
- Removed or renamed screens retain their old controllers and emit a warning.

## Validation

The phase 1 implementation passed:

```text
TypeScript compilation
Gulp release build
Full production npm build
Bridge-disabled MESP604 export
Bridge-enabled MESP604 export
Repeated export user-file preservation
Screen rename and controller preservation
Contained orphan cleanup and unsafe-path rejection
ARM GCC C11 checks for all four transports
Generated screens.c ARM GCC check against LVGL
Matching API version compile check
Mismatched API version rejection
Missing user API version rejection
Windows NSIS installer build
```

The local unsigned installer is produced as:

```text
dist/mep-fork-v1.0.3/EEZ Studio MEP FORK v1.0.3 Setup.exe
```

The upstream package and Windows file version remain `0.28.0`. The MEP fork
release is identified inside the application title.

## Development Launcher

`run-eez-studio-dev.bat` now forces the repository-local Electron binary and
uses a separate profile under `%LOCALAPPDATA%`. The local MEP fork can therefore
run beside an installed EEZ Studio instance.

## Deferred Work

Phase 1 intentionally does not include:

- EEZ-editable APP command and UI event catalogs
- typed message catalog generation
- automatic `Send APP command` action bindings
- ISR posting wrappers
- per-screen update-period editor settings
- automatic changes to firmware CMake, Make, STM32 or ESP-IDF metadata

Those items belong to later bridge phases.
