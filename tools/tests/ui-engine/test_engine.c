#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include "test_runtime.h"
#include "ui_engine.generated.h"

static enum ScreensEnum active = SCREEN_A;
static uint32_t ticks;
static ui_screen_event_cb_t event_listener;
static unsigned event_count, tick_count, pending;
static unsigned entered[2], left[2], updated[2], received[2];
static bool fail_tick, navigate, stop_on_event, stop_on_enter, stop_on_leave;

uint32_t lv_tick_get(void) { return ticks; }
enum ScreensEnum ui_screen_get_active(void) { return active; }
bool ui_screen_is_valid(enum ScreensEnum id) { return id == SCREEN_A || id == SCREEN_B; }
ui_listener_handle_t ui_add_screen_event_listener(ui_screen_event_cb_t cb, void *data)
{ (void)data; event_listener = cb; event_count++; return 1; }
ui_listener_handle_t ui_add_screen_tick_listener(ui_screen_tick_cb_t cb, void *data)
{ (void)cb; (void)data; if (fail_tick) return 0; tick_count++; return 2; }
bool ui_remove_screen_event_listener(ui_listener_handle_t id)
{ assert(id == 1 && event_count > 0); event_count--; event_listener = NULL; return true; }
bool ui_remove_screen_tick_listener(ui_listener_handle_t id)
{ assert(id == 2 && tick_count > 0); tick_count--; return true; }
bool UiMessageBus_Init(void) { return true; }
bool UiEvents_Receive(ui_event_t *event)
{ if (!pending) return false; pending--; event->id = 1; return true; }

static void enter_a(void) { entered[0]++; if (stop_on_enter) UiEngine_Stop(); }
static void enter_b(void) { entered[1]++; }
static void leave_a(void) { left[0]++; if (stop_on_leave) UiEngine_Stop(); }
static void leave_b(void) { left[1]++; }
static void update_a(uint32_t ms) { assert(ms >= 30); updated[0]++; }
static void update_b(uint32_t ms) { assert(ms >= 30); updated[1]++; }
static void event_a(const ui_event_t *event)
{
    (void)event;
    received[0]++;
    if (stop_on_event) { UiEngine_Stop(); return; }
    if (navigate) {
        active = SCREEN_B;
        event_listener(SCREEN_A, UI_SCREEN_EVENT_UNLOADED, NULL);
        event_listener(SCREEN_B, UI_SCREEN_EVENT_LOADED, NULL);
    }
}
static void event_b(const ui_event_t *event) { (void)event; received[1]++; }
static const ui_screen_controller_t controllers[] = {
    { SCREEN_A, 30, enter_a, update_a, event_a, leave_a },
    { SCREEN_B, 30, enter_b, update_b, event_b, leave_b }
};
int32_t ui_screen_registry_find_index(enum ScreensEnum id) { return ui_screen_is_valid(id) ? id - 1 : -1; }
const ui_screen_controller_t *ui_screen_registry_get(uint32_t i) { return i < 2 ? &controllers[i] : NULL; }
const ui_screen_controller_t *ui_screen_registry_find(enum ScreensEnum id)
{ return ui_screen_registry_get((uint32_t)ui_screen_registry_find_index(id)); }

int main(void)
{
    fail_tick = true;
    assert(!UiEngine_Init() && event_count == 0 && tick_count == 0);
    fail_tick = false;
    assert(UiEngine_Init() && UiEngine_Init());
    assert(event_count == 1 && tick_count == 1);
    assert(UiEngine_Start() && UiEngine_Start() && entered[0] == 1);

    pending = 3; navigate = true; ticks = 40;
    UiEngine_Tick();
    assert(received[0] == 1 && pending == 2 && updated[0] == 0);
    assert(left[0] == 1 && entered[1] == 1);
    ticks = 80;
    UiEngine_Tick();
    assert(received[1] == 2 && pending == 0 && updated[1] == 1);

    active = SCREEN_A; navigate = false; ticks = 120;
    UiEngine_Tick();
    assert(left[1] == 1 && entered[0] == 2);
    stop_on_event = true; pending = 1; ticks = 160;
    UiEngine_Tick();
    assert(!UiEngine_IsStarted() && !UiEngine_IsInitialized());
    assert(event_count == 0 && tick_count == 0 && updated[0] == 0);

    stop_on_event = false; stop_on_enter = true;
    assert(UiEngine_Init() && !UiEngine_Start());
    assert(!UiEngine_IsInitialized() && event_count == 0 && tick_count == 0);
    stop_on_enter = false;
    assert(UiEngine_Init() && UiEngine_Start());
    const unsigned b_entries = entered[1];
    stop_on_leave = true; active = SCREEN_B;
    UiEngine_Tick();
    assert(!UiEngine_IsStarted() && entered[1] == b_entries);
    assert(event_count == 0 && tick_count == 0);
    stop_on_leave = false; active = SCREEN_A;
    assert(UiEngine_Init() && UiEngine_Start());
    UiEngine_Stop(); UiEngine_Stop();
    assert(event_count == 0 && tick_count == 0);
    puts("PASS: init/stop/restart, listener cleanup, event budget, navigation and reentrant stop");
    return 0;
}
