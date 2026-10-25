#pragma once
#include <stdbool.h>
#include <stdint.h>

enum ScreensEnum { SCREEN_ID_NONE, SCREEN_A, SCREEN_B };
typedef enum { UI_SCREEN_EVENT_LOADED, UI_SCREEN_EVENT_UNLOADED } ui_screen_event_t;
typedef uint8_t ui_listener_handle_t;
#define UI_LISTENER_HANDLE_INVALID 0
#define UI_SCREEN_CONTROLLER_COUNT 2U
#define UI_BRIDGE_MAX_EVENTS_PER_TICK 2U

typedef struct { unsigned id; } ui_event_t;
typedef void (*ui_screen_event_cb_t)(enum ScreensEnum, ui_screen_event_t, void *);
typedef void (*ui_screen_tick_cb_t)(enum ScreensEnum, void *);
typedef struct {
    enum ScreensEnum id;
    uint32_t update_period_ms;
    void (*enter)(void);
    void (*update)(uint32_t);
    void (*on_event)(const ui_event_t *);
    void (*leave)(void);
} ui_screen_controller_t;

uint32_t lv_tick_get(void);
enum ScreensEnum ui_screen_get_active(void);
bool ui_screen_is_valid(enum ScreensEnum);
ui_listener_handle_t ui_add_screen_event_listener(ui_screen_event_cb_t, void *);
ui_listener_handle_t ui_add_screen_tick_listener(ui_screen_tick_cb_t, void *);
bool ui_remove_screen_event_listener(ui_listener_handle_t);
bool ui_remove_screen_tick_listener(ui_listener_handle_t);
int32_t ui_screen_registry_find_index(enum ScreensEnum);
const ui_screen_controller_t *ui_screen_registry_get(uint32_t);
const ui_screen_controller_t *ui_screen_registry_find(enum ScreensEnum);
bool UiMessageBus_Init(void);
bool UiEvents_Receive(ui_event_t *);
