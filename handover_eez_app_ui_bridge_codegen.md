# EEZ Studio MEP Fork - App/UI Bridge Codegen Handover

Date: 2026-07-23
Branch: `mesp-lvgl-codegen`
Release: `MEP FORK v1.0.3`
Status: phase 1 implemented and validated locally

## Goal

Generate the reusable infrastructure for strict bidirectional communication:

```text
UI -> APP command
APP -> UI event
```

The generated bridge keeps application operations out of LVGL callbacks and
keeps direct LVGL object access out of application tasks. It is portable across
ESP32, STM32 and custom platforms.

## Project Settings

The LVGL Build settings now contain:

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

The bridge is disabled by default, so existing projects retain their previous
output until it is explicitly enabled.

Transport choices:

```text
Custom
FreeRTOS - ESP-IDF includes
FreeRTOS - standard includes
CMSIS-RTOS2
```

## Generated Files

EEZ owns and rewrites:

```text
ui_app/generated/
    ui_bridge_config.generated.h
    ui_engine.generated.c
    ui_engine.generated.h
    ui_message_bus.generated.c
    ui_message_bus.generated.h
    ui_screen_registry.generated.c
    ui_screen_registry.generated.h
    ui_bridge_sources.cmake
    ui_bridge_sources.mk
    .eez-bridge-build
```

`ui_message_bus.generated.c` is generated for the three built-in RTOS
transports. Custom transport implementations remain user-owned.

## User-Owned Files

When `Generate missing user files` is enabled, EEZ creates these only if they do
not already exist:

```text
ui_app/contract/ui_messages.h
ui_app/screens/<screen>/<screen>_screen_controller.h
ui_app/screens/<screen>/<screen>_screen_controller.c
ui_app/platform/ui_message_bus.h
ui_app/platform/ui_message_bus.c
app/app_ui_commands.h
app/app_ui_commands.c
```

The platform scaffold is created only for `Custom`. Existing user-owned files
are never opened for writing and are never included in orphan cleanup.

After a screen rename or removal, its old controller is retained and a warning
identifies the possible orphan.

## Generated Runtime API

The UI engine API is:

```c
bool UiEngine_Init(void);
bool UiEngine_Start(void);
void UiEngine_Stop(void);
void UiEngine_Tick(void);
bool UiEngine_IsInitialized(void);
bool UiEngine_IsStarted(void);
```

`UiEngine_Init()` initializes the message bus and registers lifecycle and tick
listeners. `UiEngine_Start()` attaches an already active screen if necessary.

No additional LVGL timer is created. `UiEngine_Tick()` runs through the existing
generated `ui_screens_tick()` path, so controller code and APP event dispatch
remain in the LVGL context.

The engine:

- calls `Enter()` after `UI_SCREEN_EVENT_LOADED`,
- calls `Leave()` after `UI_SCREEN_EVENT_UNLOADED`,
- dispatches at most the configured number of events per tick,
- dispatches events only to the active screen controller,
- calls `Update(elapsed_ms)` only after the configured period,
- disables periodic update when `update_period_ms` is zero.

## Multi-Listener Screen API

Generated `screens.h` now also exposes:

```c
ui_listener_handle_t ui_add_screen_event_listener(
    ui_screen_event_cb_t callback,
    void *user_data
);
bool ui_remove_screen_event_listener(ui_listener_handle_t handle);

ui_listener_handle_t ui_add_screen_tick_listener(
    ui_screen_tick_cb_t callback,
    void *user_data
);
bool ui_remove_screen_tick_listener(ui_listener_handle_t handle);
```

Both listener lists use fixed static capacity and no heap allocation. The
existing `ui_set_screen_event_callback()` and
`ui_set_screen_tick_callback()` APIs remain available for compatibility.

## Message Contract

The initial user-owned `ui_messages.h` scaffold defines:

```c
#define UI_BRIDGE_USER_API_VERSION 0x00010003U

UI_EVENT_NONE
APP_CMD_NONE

ui_event_t
app_command_t
```

Payload storage supports:

```text
bool
int32_t
uint32_t
float
```

Project-specific IDs are added manually in phase 1. The generated and
user-owned headers contain a bridge API version guard.

Generated public headers compare:

```c
UI_BRIDGE_USER_API_VERSION
UI_BRIDGE_API_VERSION
```

Compilation stops with `#error` when the user-owned version is missing or does
not match the generated version. This prevents a preserved, older message
contract from being used silently with a newer generated engine.

Projects that already received `ui_messages.h` from an earlier phase 1 build
must add the following line manually because user-owned files are never
overwritten:

```c
#define UI_BRIDGE_USER_API_VERSION 0x00010003U
```

When a future bridge API is adopted, update the user-owned implementation first
and then change this value to the version required by the generated
`ui_bridge_config.generated.h`.

## Message Bus

Every transport provides the same public API:

```c
bool UiMessageBus_Init(void);

bool UiEvents_Post(const ui_event_t *event);
bool UiEvents_Receive(ui_event_t *event);

bool AppCmds_Post(const app_command_t *command);
bool AppCmds_Receive(app_command_t *command);

uint32_t UiEvents_GetDroppedCount(void);
uint32_t UiEvents_GetReceivedCount(void);
uint32_t AppCmds_GetDroppedCount(void);
uint32_t AppCmds_GetReceivedCount(void);
```

All queue operations are nonblocking. Built-in backends copy complete message
structures into their queues. These APIs are for task context; no ISR-specific
posting API is generated.

## Firmware Integration

Add the generated source list to the firmware build. For CMake:

```cmake
include(path/to/ui_app/generated/ui_bridge_sources.cmake)

target_sources(your_target PRIVATE ${EEZ_APP_UI_BRIDGE_SOURCES})
target_include_directories(
    your_target
    PRIVATE ${EEZ_APP_UI_BRIDGE_INCLUDE_DIRS}
)
```

For ESP-IDF, include the file before `idf_component_register()` and add the two
variables to its `SRCS` and `INCLUDE_DIRS` arguments.

After normal generated UI initialization:

```c
if (!UiEngine_Init()) {
    /* Handle transport or listener initialization failure. */
}
(void)UiEngine_Start();
```

The application task or main loop processes UI commands:

```c
(void)AppUiCommands_Process(8U);
```

The bounded argument prevents one queue from monopolizing the APP task.

## UI To APP Example

A native EEZ/LVGL action can post a command:

```c
void action_set_output(lv_event_t *event)
{
    (void)event;

    const app_command_t command = {
        .id = APP_CMD_SET_OUTPUT,
        .data.state = true
    };

    (void)AppCmds_Post(&command);
}
```

The callback only queues the request. GPIO, storage, network and other
application operations belong in `AppUiCommands_Process()` or code it calls.

## APP To UI Example

An application task can post an event:

```c
const ui_event_t event = {
    .id = UI_EVENT_OUTPUT_CHANGED,
    .data.state = output_state
};

(void)UiEvents_Post(&event);
```

The active screen controller receives it later from the LVGL tick context:

```c
void MainScreen_OnAppEvent(const ui_event_t *event)
{
    if (event == NULL) {
        return;
    }

    switch (event->id) {
    case UI_EVENT_OUTPUT_CHANGED:
        /* Update generated LVGL objects here. */
        break;
    default:
        break;
    }
}
```

## Regeneration Safety

Bridge-generated files use a dedicated manifest:

```text
ui_app/generated/.eez-bridge-build
```

The standard `.eez-project-build` manifest never tracks bridge files.
Generated writes and orphan cleanup validate relative paths, resolved parent
paths, root containment and regular-file status. The manifest itself uses the
same checked writer.

User-owned files are created with exclusive create semantics. A second export
therefore cannot truncate or replace an existing controller, message contract,
custom transport or APP handler.

## Validation

Completed checks:

```text
TypeScript --noEmit: passed
Gulp release build: passed
Bridge-disabled MESP604 export: passed
Bridge-enabled MESP604 export: passed
Standard UI output comparison: identical
Repeated export controller preservation: byte-identical
Screen rename registry/controller handling: passed
Safe generated orphan cleanup: passed
Unsafe ../ manifest path rejection: passed
ESP-IDF FreeRTOS bridge C11 syntax: passed
Standard FreeRTOS bridge C11 syntax: passed
CMSIS-RTOS2 bridge C11 syntax: passed
Custom bridge C11 syntax: passed
Matching user/generated API versions: passed
Mismatched user/generated API versions: rejected as expected
Missing user-owned API version: rejected as expected
Generated screens.c syntax against LVGL: passed
```

All bridge C checks used ARM GCC with `-Wall -Wextra -Werror`. The full
`screens.c` check ignored existing LVGL deprecation diagnostics for legacy flag
setters; no new compile error remained.

## Phase 1 Constraints

- Message IDs and payload meanings remain project-owned.
- Per-screen update periods currently use one global default.
- No ISR posting wrappers are generated.
- The custom transport scaffold intentionally returns failure until implemented.
- EEZ does not edit firmware CMake, Make, STM32 project or ESP-IDF metadata.
- Message catalog editing and automatic `Send APP command` actions belong to
  phases 2 and 3.

## Suggested Commit

```text
feat(lvgl): generate portable app ui bridge
```

Suggested body:

```text
Add optional App/UI bridge generation with screen controllers, bounded event
dispatch and portable queue backends. Preserve user-owned files across exports,
track generated output in a contained manifest and expose multi-listener screen
lifecycle APIs.
```
