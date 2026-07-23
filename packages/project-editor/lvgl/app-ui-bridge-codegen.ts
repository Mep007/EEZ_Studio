import fs from "fs";
import path from "path";

import { MessageType } from "project-editor/core/object";
import { Section, type ProjectStore } from "project-editor/store";
import { getLvglScreenIdentifier } from "project-editor/lvgl/screen-codegen-helpers";

const BRIDGE_MANIFEST_VERSION = 1;
const BRIDGE_API_VERSION = "0x00010003U";

interface BridgeSettings {
    bridgeRoot: string;
    applicationRoot: string;
    transport:
        | "custom"
        | "freertos-esp-idf"
        | "freertos"
        | "cmsis-rtos2";
    defaultUpdatePeriod: number;
    generateMissingUserFiles: boolean;
    uiEventQueueLength: number;
    appCommandQueueLength: number;
    maxEventsPerTick: number;
}

interface ScreenMetadata {
    enumName: string;
    identifier: string;
    functionPrefix: string;
    controllerHeaderPath: string;
    controllerSourcePath: string;
    controllerAvailable: boolean;
}

interface BridgeManifest {
    version: number;
    generatedFiles: string[];
    screens: {
        identifier: string;
        controllerSourcePath: string;
    }[];
}

function toPosix(filePath: string) {
    return filePath.replace(/\\/g, "/");
}

function normalizeText(content: string) {
    return content
        .replace(/^\n/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/\s+$/, "") + "\n";
}

function isPathInside(rootPath: string, candidatePath: string) {
    const relativePath = path.relative(rootPath, candidatePath);
    return (
        relativePath === "" ||
        (!path.isAbsolute(relativePath) &&
            relativePath !== ".." &&
            !relativePath.startsWith(`..${path.sep}`))
    );
}

function resolveInside(rootPath: string, relativePath: string) {
    if (!relativePath || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid relative bridge path: ${relativePath}`);
    }

    const resolvedPath = path.resolve(rootPath, relativePath);
    if (!isPathInside(rootPath, resolvedPath) || resolvedPath === rootPath) {
        throw new Error(`Bridge path escapes its root: ${relativePath}`);
    }

    return resolvedPath;
}

function toFunctionPrefix(identifier: string) {
    return identifier
        .split("_")
        .filter(part => part.length > 0)
        .map(part => part[0].toUpperCase() + part.slice(1))
        .join("");
}

function getIntegerSetting(
    name: string,
    value: number,
    minimum: number,
    maximum: number
) {
    if (
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new Error(
            `${name} must be an integer from ${minimum} to ${maximum}.`
        );
    }

    return value;
}

function writeOutput(
    projectStore: ProjectStore,
    type: MessageType,
    message: string
) {
    projectStore.outputSectionsStore.write(Section.OUTPUT, type, message);
}

async function readManifest(
    manifestPath: string,
    generatedRootRealPath: string
): Promise<BridgeManifest | undefined> {
    try {
        const stat = await fs.promises.lstat(manifestPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return undefined;
        }

        const manifestRealPath = await fs.promises.realpath(manifestPath);
        if (!isPathInside(generatedRootRealPath, manifestRealPath)) {
            return undefined;
        }

        const manifest = JSON.parse(
            await fs.promises.readFile(manifestPath, "utf8")
        ) as Partial<BridgeManifest>;

        if (
            manifest.version !== BRIDGE_MANIFEST_VERSION ||
            !Array.isArray(manifest.generatedFiles) ||
            !Array.isArray(manifest.screens)
        ) {
            return undefined;
        }

        return manifest as BridgeManifest;
    } catch (error) {
        return undefined;
    }
}

async function writeGeneratedFile(
    generatedRoot: string,
    generatedRootRealPath: string,
    relativePath: string,
    content: string
) {
    const filePath = resolveInside(generatedRoot, relativePath);
    const parentPath = path.dirname(filePath);
    await fs.promises.mkdir(parentPath, { recursive: true });

    const parentRealPath = await fs.promises.realpath(parentPath);
    if (!isPathInside(generatedRootRealPath, parentRealPath)) {
        throw new Error(
            `Generated bridge path resolves outside generated root: ${relativePath}`
        );
    }

    try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(
                `Refusing to replace non-regular generated file: ${relativePath}`
            );
        }
    } catch (error: any) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }

    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        const temporaryFileHandle = await fs.promises.open(
            temporaryPath,
            "wx"
        );
        try {
            await temporaryFileHandle.writeFile(
                normalizeText(content),
                "utf8"
            );
        } finally {
            await temporaryFileHandle.close();
        }
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true });
        throw error;
    }

    try {
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
            await fs.promises.rm(temporaryPath, { force: true });
            throw error;
        }

        await fs.promises.unlink(filePath);
        await fs.promises.rename(temporaryPath, filePath);
    }
}

async function writeUserFileIfMissing(
    userRoot: string,
    userRootRealPath: string,
    relativePath: string,
    content: string
) {
    const filePath = resolveInside(userRoot, relativePath);
    const parentPath = path.dirname(filePath);
    await fs.promises.mkdir(parentPath, { recursive: true });

    const parentRealPath = await fs.promises.realpath(parentPath);
    if (!isPathInside(userRootRealPath, parentRealPath)) {
        throw new Error(
            `User bridge path resolves outside bridge root: ${relativePath}`
        );
    }

    let fileHandle: fs.promises.FileHandle | undefined;
    try {
        fileHandle = await fs.promises.open(filePath, "wx");
        await fileHandle.writeFile(normalizeText(content), "utf8");
        return true;
    } catch (error: any) {
        if (error?.code === "EEXIST") {
            return false;
        }
        throw error;
    } finally {
        await fileHandle?.close();
    }
}

async function cleanupGeneratedFiles(
    projectStore: ProjectStore,
    generatedRoot: string,
    generatedRootRealPath: string,
    previousFiles: string[],
    currentFiles: string[]
) {
    const currentSet = new Set(currentFiles);

    for (const relativePath of previousFiles) {
        if (currentSet.has(relativePath)) {
            continue;
        }

        let filePath: string;
        try {
            filePath = resolveInside(generatedRoot, relativePath);
        } catch (error) {
            writeOutput(
                projectStore,
                MessageType.WARNING,
                `Skipped unsafe App/UI bridge manifest path: ${relativePath}`
            );
            continue;
        }

        try {
            const fileRealPath = await fs.promises.realpath(filePath);
            if (!isPathInside(generatedRootRealPath, fileRealPath)) {
                writeOutput(
                    projectStore,
                    MessageType.WARNING,
                    `Skipped App/UI bridge orphan outside generated root: ${relativePath}`
                );
                continue;
            }

            const stat = await fs.promises.lstat(filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                writeOutput(
                    projectStore,
                    MessageType.WARNING,
                    `Skipped non-regular App/UI bridge orphan: ${relativePath}`
                );
                continue;
            }

            await fs.promises.unlink(filePath);
            writeOutput(
                projectStore,
                MessageType.INFO,
                `Deleted App/UI bridge generated orphan: ${relativePath}`
            );
        } catch (error: any) {
            if (error?.code !== "ENOENT") {
                writeOutput(
                    projectStore,
                    MessageType.WARNING,
                    `Could not delete App/UI bridge orphan ${relativePath}: ${error}`
                );
            }
        }
    }
}

function getSettings(projectStore: ProjectStore): BridgeSettings {
    const build = projectStore.project.settings.build;
    const bridgeOutputFolder =
        build.appUiBridgeOutputFolder?.trim() || "../ui_app";
    const applicationOutputFolder =
        build.appUiBridgeApplicationOutputFolder?.trim() || "../app";

    return {
        bridgeRoot: path.resolve(
            projectStore.getAbsoluteFilePath(bridgeOutputFolder)
        ),
        applicationRoot: path.resolve(
            projectStore.getAbsoluteFilePath(applicationOutputFolder)
        ),
        transport: build.appUiBridgeTransport,
        defaultUpdatePeriod: getIntegerSetting(
            "Default screen update period",
            build.appUiBridgeDefaultUpdatePeriod,
            0,
            3600000
        ),
        generateMissingUserFiles:
            build.appUiBridgeGenerateMissingUserFiles,
        uiEventQueueLength: getIntegerSetting(
            "UI event queue length",
            build.appUiBridgeUiEventQueueLength,
            1,
            65535
        ),
        appCommandQueueLength: getIntegerSetting(
            "APP command queue length",
            build.appUiBridgeAppCommandQueueLength,
            1,
            65535
        ),
        maxEventsPerTick: getIntegerSetting(
            "Maximum UI events per tick",
            build.appUiBridgeMaxEventsPerTick,
            1,
            65535
        )
    };
}

function getScreenMetadata(projectStore: ProjectStore): ScreenMetadata[] {
    return projectStore.project._store.lvglIdentifiers.pages
        .filter(page => !page.isUsedAsUserWidget)
        .map(page => {
            const identifier = getLvglScreenIdentifier(page);
            const functionPrefix = toFunctionPrefix(identifier);
            return {
                enumName: `SCREEN_ID_${identifier.toUpperCase()}`,
                identifier,
                functionPrefix,
                controllerHeaderPath: `screens/${identifier}/${identifier}_screen_controller.h`,
                controllerSourcePath: `screens/${identifier}/${identifier}_screen_controller.c`,
                controllerAvailable: false
            };
        });
}

function buildConfigHeader(settings: BridgeSettings) {
    const transportIds = {
        custom: 0,
        "freertos-esp-idf": 1,
        freertos: 2,
        "cmsis-rtos2": 3
    };

    return `
#ifndef UI_BRIDGE_CONFIG_GENERATED_H
#define UI_BRIDGE_CONFIG_GENERATED_H

#define UI_BRIDGE_API_VERSION ${BRIDGE_API_VERSION}

#define UI_BRIDGE_TRANSPORT_CUSTOM 0U
#define UI_BRIDGE_TRANSPORT_FREERTOS_ESP_IDF 1U
#define UI_BRIDGE_TRANSPORT_FREERTOS 2U
#define UI_BRIDGE_TRANSPORT_CMSIS_RTOS2 3U

#define UI_BRIDGE_TRANSPORT ${transportIds[settings.transport]}U
#define UI_BRIDGE_DEFAULT_SCREEN_UPDATE_PERIOD_MS ${settings.defaultUpdatePeriod}U
#define UI_BRIDGE_UI_EVENT_QUEUE_LENGTH ${settings.uiEventQueueLength}U
#define UI_BRIDGE_APP_COMMAND_QUEUE_LENGTH ${settings.appCommandQueueLength}U
#define UI_BRIDGE_MAX_EVENTS_PER_TICK ${settings.maxEventsPerTick}U

/*
 * The generated bridge API is task-context only. ISR producers must hand data
 * to a project-owned task before calling UiEvents_Post() or AppCmds_Post().
 */
#define UI_BRIDGE_TASK_CONTEXT_ONLY 1U

#endif /* UI_BRIDGE_CONFIG_GENERATED_H */
`;
}

function buildMessagesHeader() {
    return `
#ifndef UI_MESSAGES_H
#define UI_MESSAGES_H

#include <stdbool.h>
#include <stdint.h>

#define UI_BRIDGE_USER_API_VERSION ${BRIDGE_API_VERSION}

#include "ui_bridge_config.generated.h"

#if UI_BRIDGE_USER_API_VERSION != UI_BRIDGE_API_VERSION
#error "Update the user-owned App/UI bridge files for this generated API version."
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    UI_EVENT_NONE = 0
} ui_event_id_t;

typedef union {
    bool state;
    int32_t i32;
    uint32_t u32;
    float f32;
} ui_message_data_t;

typedef struct {
    ui_event_id_t id;
    ui_message_data_t data;
} ui_event_t;

// ------------------------------------------------------------------------------------------------

typedef enum {
    APP_CMD_NONE = 0
} app_command_id_t;

typedef struct {
    app_command_id_t id;
    ui_message_data_t data;
} app_command_t;

#ifdef __cplusplus
}
#endif

#endif /* UI_MESSAGES_H */
`;
}

function buildUserApiCompatibilityCheck() {
    return `
#ifndef UI_BRIDGE_USER_API_VERSION
#error "UI_BRIDGE_USER_API_VERSION is missing from user-owned ui_messages.h."
#elif UI_BRIDGE_USER_API_VERSION != UI_BRIDGE_API_VERSION
#error "User-owned App/UI bridge API is incompatible with generated bridge files."
#endif
`;
}

function buildMessageBusHeader() {
    return `
#ifndef UI_MESSAGE_BUS_GENERATED_H
#define UI_MESSAGE_BUS_GENERATED_H

#include <stdbool.h>
#include <stdint.h>

#include "ui_bridge_config.generated.h"
#include "ui_messages.h"

${buildUserApiCompatibilityCheck()}

#ifdef __cplusplus
extern "C" {
#endif

bool UiMessageBus_Init(void);

bool UiEvents_Post(const ui_event_t *event);
bool UiEvents_Receive(ui_event_t *event);

bool AppCmds_Post(const app_command_t *command);
bool AppCmds_Receive(app_command_t *command);

uint32_t UiEvents_GetDroppedCount(void);
uint32_t UiEvents_GetReceivedCount(void);
uint32_t AppCmds_GetDroppedCount(void);
uint32_t AppCmds_GetReceivedCount(void);

#ifdef __cplusplus
}
#endif

#endif /* UI_MESSAGE_BUS_GENERATED_H */
`;
}

function buildFreeRtosMessageBusSource(espIdfIncludes: boolean) {
    const includes = espIdfIncludes
        ? `#include "freertos/FreeRTOS.h"\n#include "freertos/queue.h"`
        : `#include "FreeRTOS.h"\n#include "queue.h"`;

    return `
#include "ui_message_bus.generated.h"

#include <stddef.h>

${includes}

static QueueHandle_t ui_events_queue;
static QueueHandle_t app_commands_queue;
static uint32_t ui_events_dropped_count;
static uint32_t ui_events_received_count;
static uint32_t app_commands_dropped_count;
static uint32_t app_commands_received_count;

bool UiMessageBus_Init(void)
{
    if (ui_events_queue != NULL && app_commands_queue != NULL) {
        return true;
    }

    ui_events_queue = xQueueCreate(
        UI_BRIDGE_UI_EVENT_QUEUE_LENGTH,
        sizeof(ui_event_t)
    );
    app_commands_queue = xQueueCreate(
        UI_BRIDGE_APP_COMMAND_QUEUE_LENGTH,
        sizeof(app_command_t)
    );

    if (ui_events_queue == NULL || app_commands_queue == NULL) {
        if (ui_events_queue != NULL) {
            vQueueDelete(ui_events_queue);
            ui_events_queue = NULL;
        }
        if (app_commands_queue != NULL) {
            vQueueDelete(app_commands_queue);
            app_commands_queue = NULL;
        }
        return false;
    }

    return true;
}

bool UiEvents_Post(const ui_event_t *event)
{
    if (event == NULL || ui_events_queue == NULL ||
        xQueueSend(ui_events_queue, event, 0U) != pdPASS) {
        ui_events_dropped_count++;
        return false;
    }
    return true;
}

bool UiEvents_Receive(ui_event_t *event)
{
    if (event == NULL || ui_events_queue == NULL ||
        xQueueReceive(ui_events_queue, event, 0U) != pdPASS) {
        return false;
    }
    ui_events_received_count++;
    return true;
}

bool AppCmds_Post(const app_command_t *command)
{
    if (command == NULL || app_commands_queue == NULL ||
        xQueueSend(app_commands_queue, command, 0U) != pdPASS) {
        app_commands_dropped_count++;
        return false;
    }
    return true;
}

bool AppCmds_Receive(app_command_t *command)
{
    if (command == NULL || app_commands_queue == NULL ||
        xQueueReceive(app_commands_queue, command, 0U) != pdPASS) {
        return false;
    }
    app_commands_received_count++;
    return true;
}

uint32_t UiEvents_GetDroppedCount(void)
{
    return ui_events_dropped_count;
}

uint32_t UiEvents_GetReceivedCount(void)
{
    return ui_events_received_count;
}

uint32_t AppCmds_GetDroppedCount(void)
{
    return app_commands_dropped_count;
}

uint32_t AppCmds_GetReceivedCount(void)
{
    return app_commands_received_count;
}
`;
}

function buildCmsisMessageBusSource() {
    return `
#include "ui_message_bus.generated.h"

#include <stddef.h>

#include "cmsis_os2.h"

static osMessageQueueId_t ui_events_queue;
static osMessageQueueId_t app_commands_queue;
static uint32_t ui_events_dropped_count;
static uint32_t ui_events_received_count;
static uint32_t app_commands_dropped_count;
static uint32_t app_commands_received_count;

bool UiMessageBus_Init(void)
{
    if (ui_events_queue != NULL && app_commands_queue != NULL) {
        return true;
    }

    ui_events_queue = osMessageQueueNew(
        UI_BRIDGE_UI_EVENT_QUEUE_LENGTH,
        sizeof(ui_event_t),
        NULL
    );
    app_commands_queue = osMessageQueueNew(
        UI_BRIDGE_APP_COMMAND_QUEUE_LENGTH,
        sizeof(app_command_t),
        NULL
    );

    if (ui_events_queue == NULL || app_commands_queue == NULL) {
        if (ui_events_queue != NULL) {
            (void)osMessageQueueDelete(ui_events_queue);
            ui_events_queue = NULL;
        }
        if (app_commands_queue != NULL) {
            (void)osMessageQueueDelete(app_commands_queue);
            app_commands_queue = NULL;
        }
        return false;
    }

    return true;
}

bool UiEvents_Post(const ui_event_t *event)
{
    if (event == NULL || ui_events_queue == NULL ||
        osMessageQueuePut(ui_events_queue, event, 0U, 0U) != osOK) {
        ui_events_dropped_count++;
        return false;
    }
    return true;
}

bool UiEvents_Receive(ui_event_t *event)
{
    if (event == NULL || ui_events_queue == NULL ||
        osMessageQueueGet(ui_events_queue, event, NULL, 0U) != osOK) {
        return false;
    }
    ui_events_received_count++;
    return true;
}

bool AppCmds_Post(const app_command_t *command)
{
    if (command == NULL || app_commands_queue == NULL ||
        osMessageQueuePut(app_commands_queue, command, 0U, 0U) != osOK) {
        app_commands_dropped_count++;
        return false;
    }
    return true;
}

bool AppCmds_Receive(app_command_t *command)
{
    if (command == NULL || app_commands_queue == NULL ||
        osMessageQueueGet(app_commands_queue, command, NULL, 0U) != osOK) {
        return false;
    }
    app_commands_received_count++;
    return true;
}

uint32_t UiEvents_GetDroppedCount(void)
{
    return ui_events_dropped_count;
}

uint32_t UiEvents_GetReceivedCount(void)
{
    return ui_events_received_count;
}

uint32_t AppCmds_GetDroppedCount(void)
{
    return app_commands_dropped_count;
}

uint32_t AppCmds_GetReceivedCount(void)
{
    return app_commands_received_count;
}
`;
}

function buildCustomMessageBusHeader() {
    return `
#ifndef UI_MESSAGE_BUS_H
#define UI_MESSAGE_BUS_H

#include "ui_message_bus.generated.h"

#endif /* UI_MESSAGE_BUS_H */
`;
}

function buildCustomMessageBusSource() {
    return `
#include "ui_message_bus.h"

/*
 * Replace this scaffold with a project-specific task-safe queue or ring buffer.
 * The generated bridge calls this API only from task context.
 */

bool UiMessageBus_Init(void)
{
    return false;
}

bool UiEvents_Post(const ui_event_t *event)
{
    (void)event;
    return false;
}

bool UiEvents_Receive(ui_event_t *event)
{
    (void)event;
    return false;
}

bool AppCmds_Post(const app_command_t *command)
{
    (void)command;
    return false;
}

bool AppCmds_Receive(app_command_t *command)
{
    (void)command;
    return false;
}

uint32_t UiEvents_GetDroppedCount(void)
{
    return 0U;
}

uint32_t UiEvents_GetReceivedCount(void)
{
    return 0U;
}

uint32_t AppCmds_GetDroppedCount(void)
{
    return 0U;
}

uint32_t AppCmds_GetReceivedCount(void)
{
    return 0U;
}
`;
}

function buildControllerHeader(screen: ScreenMetadata) {
    const guard = `${screen.identifier.toUpperCase()}_SCREEN_CONTROLLER_H`;
    return `
#ifndef ${guard}
#define ${guard}

#include <stdint.h>

#include "ui_messages.h"

#ifdef __cplusplus
extern "C" {
#endif

void ${screen.functionPrefix}Screen_Enter(void);
void ${screen.functionPrefix}Screen_Update(uint32_t elapsed_ms);
void ${screen.functionPrefix}Screen_OnAppEvent(const ui_event_t *event);
void ${screen.functionPrefix}Screen_Leave(void);

#ifdef __cplusplus
}
#endif

#endif /* ${guard} */
`;
}

function buildControllerSource(screen: ScreenMetadata) {
    return `
#include "${screen.identifier}_screen_controller.h"

#include <stddef.h>

#include "ui_bridge_config.generated.h"

#if UI_BRIDGE_USER_API_VERSION != UI_BRIDGE_API_VERSION
#error "Update this screen controller for the generated App/UI bridge API."
#endif

void ${screen.functionPrefix}Screen_Enter(void)
{
}

// ------------------------------------------------------------------------------------------------

void ${screen.functionPrefix}Screen_Update(uint32_t elapsed_ms)
{
    (void)elapsed_ms;
}

// ------------------------------------------------------------------------------------------------

void ${screen.functionPrefix}Screen_OnAppEvent(const ui_event_t *event)
{
    if (event == NULL) {
        return;
    }

    switch (event->id) {
    default:
        break;
    }
}

// ------------------------------------------------------------------------------------------------

void ${screen.functionPrefix}Screen_Leave(void)
{
}
`;
}

function buildRegistryHeader(screenCount: number) {
    return `
#ifndef UI_SCREEN_REGISTRY_GENERATED_H
#define UI_SCREEN_REGISTRY_GENERATED_H

#include <stdint.h>

#include "screens.h"
#include "ui_bridge_config.generated.h"
#include "ui_messages.h"

${buildUserApiCompatibilityCheck()}

#define UI_SCREEN_CONTROLLER_COUNT ${screenCount}U

typedef struct
{
    enum ScreensEnum id;
    uint32_t update_period_ms;
    void (*enter)(void);
    void (*update)(uint32_t elapsed_ms);
    void (*on_event)(const ui_event_t *event);
    void (*leave)(void);
} ui_screen_controller_t;

#ifdef __cplusplus
extern "C" {
#endif

uint32_t ui_screen_registry_count(void);
const ui_screen_controller_t *ui_screen_registry_get(uint32_t index);
const ui_screen_controller_t *ui_screen_registry_find(
    enum ScreensEnum screen_id
);
int32_t ui_screen_registry_find_index(enum ScreensEnum screen_id);

#ifdef __cplusplus
}
#endif

#endif /* UI_SCREEN_REGISTRY_GENERATED_H */
`;
}

function buildRegistrySource(
    generatedRoot: string,
    bridgeRoot: string,
    screens: ScreenMetadata[],
    defaultUpdatePeriod: number
) {
    const includes = screens
        .filter(screen => screen.controllerAvailable)
        .map(screen => {
            const headerPath = path.resolve(
                bridgeRoot,
                screen.controllerHeaderPath
            );
            return `#include "${toPosix(
                path.relative(generatedRoot, headerPath)
            )}"`;
        })
        .join("\n");

    const entries = screens
        .map(screen => {
            const functions = screen.controllerAvailable
                ? `${screen.functionPrefix}Screen_Enter, ${screen.functionPrefix}Screen_Update, ${screen.functionPrefix}Screen_OnAppEvent, ${screen.functionPrefix}Screen_Leave`
                : "NULL, NULL, NULL, NULL";
            return `    { ${screen.enumName}, ${defaultUpdatePeriod}U, ${functions} }`;
        })
        .join(",\n");

    return `
#include "ui_screen_registry.generated.h"

#include <stddef.h>

${includes}

#if UI_SCREEN_CONTROLLER_COUNT > 0U
static const ui_screen_controller_t screen_controllers[] = {
${entries}
};
#endif

uint32_t ui_screen_registry_count(void)
{
    return UI_SCREEN_CONTROLLER_COUNT;
}

const ui_screen_controller_t *ui_screen_registry_get(uint32_t index)
{
#if UI_SCREEN_CONTROLLER_COUNT > 0U
    return index < UI_SCREEN_CONTROLLER_COUNT
        ? &screen_controllers[index]
        : NULL;
#else
    (void)index;
    return NULL;
#endif
}

const ui_screen_controller_t *ui_screen_registry_find(
    enum ScreensEnum screen_id)
{
    int32_t index = ui_screen_registry_find_index(screen_id);
    return index >= 0 ? ui_screen_registry_get((uint32_t)index) : NULL;
}

int32_t ui_screen_registry_find_index(enum ScreensEnum screen_id)
{
#if UI_SCREEN_CONTROLLER_COUNT > 0U
    for (uint32_t i = 0U; i < UI_SCREEN_CONTROLLER_COUNT; i++) {
        if (screen_controllers[i].id == screen_id) {
            return (int32_t)i;
        }
    }
#else
    (void)screen_id;
#endif
    return -1;
}
`;
}

function buildEngineHeader() {
    return `
#ifndef UI_ENGINE_GENERATED_H
#define UI_ENGINE_GENERATED_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool UiEngine_Init(void);
bool UiEngine_Start(void);
void UiEngine_Stop(void);
void UiEngine_Tick(void);
bool UiEngine_IsInitialized(void);
bool UiEngine_IsStarted(void);

#ifdef __cplusplus
}
#endif

#endif /* UI_ENGINE_GENERATED_H */
`;
}

function buildEngineSource() {
    return `
#include "ui_engine.generated.h"

#include <stddef.h>
#include <stdint.h>

#include "screens.h"
#include "ui_bridge_config.generated.h"
#include "ui_message_bus.generated.h"
#include "ui_screen_registry.generated.h"

static bool ui_engine_initialized;
static bool ui_engine_started;
static ui_listener_handle_t screen_event_listener =
    UI_LISTENER_HANDLE_INVALID;
static ui_listener_handle_t screen_tick_listener =
    UI_LISTENER_HANDLE_INVALID;
static enum ScreensEnum active_controller_id = SCREEN_ID_NONE;
static uint32_t active_controller_update_tick;

#if UI_SCREEN_CONTROLLER_COUNT > 0U
static bool controller_entered[UI_SCREEN_CONTROLLER_COUNT];
#endif

static void ui_engine_enter_controller(enum ScreensEnum screen_id)
{
    int32_t index = ui_screen_registry_find_index(screen_id);
    if (index < 0) {
        return;
    }

#if UI_SCREEN_CONTROLLER_COUNT > 0U
    if (controller_entered[index]) {
        active_controller_id = screen_id;
        return;
    }

    const ui_screen_controller_t *controller =
        ui_screen_registry_get((uint32_t)index);
    controller_entered[index] = true;
    active_controller_id = screen_id;
    active_controller_update_tick = lv_tick_get();

    if (controller != NULL && controller->enter != NULL) {
        controller->enter();
    }
#else
    (void)screen_id;
#endif
}

static void ui_engine_leave_controller(enum ScreensEnum screen_id)
{
    int32_t index = ui_screen_registry_find_index(screen_id);
    if (index < 0) {
        return;
    }

#if UI_SCREEN_CONTROLLER_COUNT > 0U
    if (!controller_entered[index]) {
        return;
    }

    const ui_screen_controller_t *controller =
        ui_screen_registry_get((uint32_t)index);
    controller_entered[index] = false;

    if (controller != NULL && controller->leave != NULL) {
        controller->leave();
    }

    if (active_controller_id == screen_id) {
        active_controller_id = SCREEN_ID_NONE;
    }
#else
    (void)screen_id;
#endif
}

static void ui_engine_screen_event(
    enum ScreensEnum screen_id,
    ui_screen_event_t event,
    void *user_data)
{
    (void)user_data;

    if (!ui_engine_started) {
        return;
    }

    if (event == UI_SCREEN_EVENT_LOADED) {
        ui_engine_enter_controller(screen_id);
    } else if (event == UI_SCREEN_EVENT_UNLOADED) {
        ui_engine_leave_controller(screen_id);
    }
}

static void ui_engine_screen_tick(
    enum ScreensEnum screen_id,
    void *user_data)
{
    (void)screen_id;
    (void)user_data;
    UiEngine_Tick();
}

static void ui_engine_dispatch_events(
    const ui_screen_controller_t *controller)
{
    if (controller == NULL || controller->on_event == NULL) {
        return;
    }

    for (uint32_t i = 0U; i < UI_BRIDGE_MAX_EVENTS_PER_TICK; i++) {
        ui_event_t event;
        if (!UiEvents_Receive(&event)) {
            break;
        }
        controller->on_event(&event);
    }
}

static void ui_engine_update_controller(
    const ui_screen_controller_t *controller)
{
    if (controller == NULL || controller->update == NULL ||
        controller->update_period_ms == 0U) {
        return;
    }

    uint32_t now = lv_tick_get();
    uint32_t elapsed_ms = now - active_controller_update_tick;
    if (elapsed_ms < controller->update_period_ms) {
        return;
    }

    active_controller_update_tick = now;
    controller->update(elapsed_ms);
}

bool UiEngine_Init(void)
{
    if (ui_engine_initialized) {
        return true;
    }

    if (!UiMessageBus_Init()) {
        return false;
    }

    screen_event_listener = ui_add_screen_event_listener(
        ui_engine_screen_event,
        NULL
    );
    if (screen_event_listener == UI_LISTENER_HANDLE_INVALID) {
        return false;
    }

    screen_tick_listener = ui_add_screen_tick_listener(
        ui_engine_screen_tick,
        NULL
    );
    if (screen_tick_listener == UI_LISTENER_HANDLE_INVALID) {
        (void)ui_remove_screen_event_listener(screen_event_listener);
        screen_event_listener = UI_LISTENER_HANDLE_INVALID;
        return false;
    }

    ui_engine_initialized = true;
    return true;
}

bool UiEngine_Start(void)
{
    if (!ui_engine_initialized || ui_engine_started) {
        return ui_engine_started;
    }

    ui_engine_started = true;

    enum ScreensEnum screen_id = ui_screen_get_active();
    if (ui_screen_is_valid(screen_id)) {
        ui_engine_enter_controller(screen_id);
    }

    return true;
}

void UiEngine_Stop(void)
{
    if (!ui_engine_initialized) {
        return;
    }

    ui_engine_started = false;

#if UI_SCREEN_CONTROLLER_COUNT > 0U
    for (uint32_t i = 0U; i < UI_SCREEN_CONTROLLER_COUNT; i++) {
        const ui_screen_controller_t *controller =
            ui_screen_registry_get(i);
        if (controller != NULL && controller_entered[i]) {
            controller_entered[i] = false;
            if (controller->leave != NULL) {
                controller->leave();
            }
        }
    }
#endif

    active_controller_id = SCREEN_ID_NONE;

    (void)ui_remove_screen_event_listener(screen_event_listener);
    (void)ui_remove_screen_tick_listener(screen_tick_listener);
    screen_event_listener = UI_LISTENER_HANDLE_INVALID;
    screen_tick_listener = UI_LISTENER_HANDLE_INVALID;
    ui_engine_initialized = false;
}

void UiEngine_Tick(void)
{
    if (!ui_engine_started) {
        return;
    }

    enum ScreensEnum screen_id = ui_screen_get_active();
    if (!ui_screen_is_valid(screen_id)) {
        return;
    }

    if (active_controller_id != screen_id) {
        ui_engine_enter_controller(screen_id);
    }

    const ui_screen_controller_t *controller =
        ui_screen_registry_find(screen_id);
    ui_engine_dispatch_events(controller);
    ui_engine_update_controller(controller);
}

bool UiEngine_IsInitialized(void)
{
    return ui_engine_initialized;
}

bool UiEngine_IsStarted(void)
{
    return ui_engine_started;
}
`;
}

function buildAppCommandHeader() {
    return `
#ifndef APP_UI_COMMANDS_H
#define APP_UI_COMMANDS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint32_t AppUiCommands_Process(uint32_t max_commands);

#ifdef __cplusplus
}
#endif

#endif /* APP_UI_COMMANDS_H */
`;
}

function buildAppCommandSource() {
    return `
#include "app_ui_commands.h"

#include "ui_message_bus.generated.h"

uint32_t AppUiCommands_Process(uint32_t max_commands)
{
    uint32_t processed = 0U;
    app_command_t command;

    while (processed < max_commands && AppCmds_Receive(&command)) {
        switch (command.id) {
        default:
            break;
        }
        processed++;
    }

    return processed;
}
`;
}

function quoteCmakePath(
    generatedRoot: string,
    absolutePath: string
) {
    const relativePath = toPosix(path.relative(generatedRoot, absolutePath));
    return `    "\${CMAKE_CURRENT_LIST_DIR}/${relativePath}"`;
}

function buildCmakeSources(
    generatedRoot: string,
    sourceFiles: string[],
    includeFolders: string[]
) {
    return `
# Generated by EEZ Studio MEP Fork. Include this file before registering the
# firmware target, then append EEZ_APP_UI_BRIDGE_SOURCES and
# EEZ_APP_UI_BRIDGE_INCLUDE_DIRS to that target.

set(EEZ_APP_UI_BRIDGE_SOURCES
${sourceFiles
    .map(filePath => quoteCmakePath(generatedRoot, filePath))
    .join("\n")}
)

set(EEZ_APP_UI_BRIDGE_INCLUDE_DIRS
${includeFolders
    .map(folderPath => quoteCmakePath(generatedRoot, folderPath))
    .join("\n")}
)
`;
}

function buildMakeSources(
    generatedRoot: string,
    sourceFiles: string[],
    includeFolders: string[]
) {
    const sources = sourceFiles
        .map(filePath => toPosix(path.relative(generatedRoot, filePath)))
        .map(filePath => `    $(UI_BRIDGE_GENERATED_DIR)/${filePath}`)
        .join(" \\\n");
    const includes = includeFolders
        .map(folderPath => toPosix(path.relative(generatedRoot, folderPath)))
        .map(
            folderPath =>
                `    -I$(UI_BRIDGE_GENERATED_DIR)/${folderPath}`
        )
        .join(" \\\n");

    return `
# Set UI_BRIDGE_GENERATED_DIR to the directory containing this file.

EEZ_APP_UI_BRIDGE_SOURCES += \\
${sources}

EEZ_APP_UI_BRIDGE_INCLUDES += \\
${includes}
`;
}

export async function generateAppUiBridge(projectStore: ProjectStore) {
    const project = projectStore.project;
    if (
        !project.projectTypeTraits.isLVGL ||
        !project.settings.build.generateAppUiBridge
    ) {
        return;
    }

    const settings = getSettings(projectStore);
    const generatedRoot = path.resolve(settings.bridgeRoot, "generated");
    const contractRoot = path.resolve(settings.bridgeRoot, "contract");
    const screensRoot = path.resolve(settings.bridgeRoot, "screens");
    const platformRoot = path.resolve(settings.bridgeRoot, "platform");
    const uiDestinationRoot = path.resolve(
        projectStore.getAbsoluteFilePath(
            project.settings.build.destinationFolder || "."
        )
    );

    await fs.promises.mkdir(generatedRoot, { recursive: true });
    await fs.promises.mkdir(settings.bridgeRoot, { recursive: true });
    await fs.promises.mkdir(settings.applicationRoot, { recursive: true });

    const generatedRootRealPath = await fs.promises.realpath(generatedRoot);
    const bridgeRootRealPath = await fs.promises.realpath(settings.bridgeRoot);
    const applicationRootRealPath = await fs.promises.realpath(
        settings.applicationRoot
    );

    if (!isPathInside(bridgeRootRealPath, generatedRootRealPath)) {
        throw new Error(
            "App/UI bridge generated directory resolves outside the bridge output folder."
        );
    }

    const manifestPath = path.join(generatedRoot, ".eez-bridge-build");
    const previousManifest = await readManifest(
        manifestPath,
        generatedRootRealPath
    );
    const screens = getScreenMetadata(projectStore);

    if (settings.generateMissingUserFiles) {
        await writeUserFileIfMissing(
            settings.bridgeRoot,
            bridgeRootRealPath,
            "contract/ui_messages.h",
            buildMessagesHeader()
        );

        for (const screen of screens) {
            await writeUserFileIfMissing(
                settings.bridgeRoot,
                bridgeRootRealPath,
                screen.controllerHeaderPath,
                buildControllerHeader(screen)
            );
            await writeUserFileIfMissing(
                settings.bridgeRoot,
                bridgeRootRealPath,
                screen.controllerSourcePath,
                buildControllerSource(screen)
            );
        }

        if (settings.transport === "custom") {
            await writeUserFileIfMissing(
                settings.bridgeRoot,
                bridgeRootRealPath,
                "platform/ui_message_bus.h",
                buildCustomMessageBusHeader()
            );
            await writeUserFileIfMissing(
                settings.bridgeRoot,
                bridgeRootRealPath,
                "platform/ui_message_bus.c",
                buildCustomMessageBusSource()
            );
        }

        await writeUserFileIfMissing(
            settings.applicationRoot,
            applicationRootRealPath,
            "app_ui_commands.h",
            buildAppCommandHeader()
        );
        await writeUserFileIfMissing(
            settings.applicationRoot,
            applicationRootRealPath,
            "app_ui_commands.c",
            buildAppCommandSource()
        );
    }

    for (const screen of screens) {
        screen.controllerAvailable =
            fs.existsSync(
                path.resolve(
                    settings.bridgeRoot,
                    screen.controllerHeaderPath
                )
            ) &&
            fs.existsSync(
                path.resolve(
                    settings.bridgeRoot,
                    screen.controllerSourcePath
                )
            );

        if (!screen.controllerAvailable) {
            writeOutput(
                projectStore,
                MessageType.WARNING,
                `App/UI bridge controller is missing for screen ${screen.identifier}.`
            );
        }
    }

    if (previousManifest) {
        const currentIdentifiers = new Set(
            screens.map(screen => screen.identifier)
        );
        for (const previousScreen of previousManifest.screens) {
            if (!currentIdentifiers.has(previousScreen.identifier)) {
                writeOutput(
                    projectStore,
                    MessageType.WARNING,
                    `App/UI bridge user controller may be orphaned after screen removal or rename: ${previousScreen.controllerSourcePath}`
                );
            }
        }
    }

    const generatedFiles = new Map<string, string>();
    generatedFiles.set(
        "ui_bridge_config.generated.h",
        buildConfigHeader(settings)
    );
    generatedFiles.set(
        "ui_message_bus.generated.h",
        buildMessageBusHeader()
    );
    generatedFiles.set(
        "ui_screen_registry.generated.h",
        buildRegistryHeader(screens.length)
    );
    generatedFiles.set(
        "ui_screen_registry.generated.c",
        buildRegistrySource(
            generatedRoot,
            settings.bridgeRoot,
            screens,
            settings.defaultUpdatePeriod
        )
    );
    generatedFiles.set("ui_engine.generated.h", buildEngineHeader());
    generatedFiles.set("ui_engine.generated.c", buildEngineSource());

    if (settings.transport === "freertos-esp-idf") {
        generatedFiles.set(
            "ui_message_bus.generated.c",
            buildFreeRtosMessageBusSource(true)
        );
    } else if (settings.transport === "freertos") {
        generatedFiles.set(
            "ui_message_bus.generated.c",
            buildFreeRtosMessageBusSource(false)
        );
    } else if (settings.transport === "cmsis-rtos2") {
        generatedFiles.set(
            "ui_message_bus.generated.c",
            buildCmsisMessageBusSource()
        );
    }

    const sourceFiles = [
        path.join(generatedRoot, "ui_engine.generated.c"),
        path.join(generatedRoot, "ui_screen_registry.generated.c")
    ];

    if (settings.transport === "custom") {
        const customSource = path.join(platformRoot, "ui_message_bus.c");
        if (fs.existsSync(customSource)) {
            sourceFiles.push(customSource);
        }
    } else {
        sourceFiles.push(
            path.join(generatedRoot, "ui_message_bus.generated.c")
        );
    }

    for (const screen of screens) {
        if (screen.controllerAvailable) {
            sourceFiles.push(
                path.resolve(
                    settings.bridgeRoot,
                    screen.controllerSourcePath
                )
            );
        }
    }

    const appCommandSource = path.join(
        settings.applicationRoot,
        "app_ui_commands.c"
    );
    if (fs.existsSync(appCommandSource)) {
        sourceFiles.push(appCommandSource);
    }

    const includeFolders = [
        generatedRoot,
        contractRoot,
        screensRoot,
        platformRoot,
        settings.applicationRoot,
        uiDestinationRoot
    ];

    generatedFiles.set(
        "ui_bridge_sources.cmake",
        buildCmakeSources(generatedRoot, sourceFiles, includeFolders)
    );
    generatedFiles.set(
        "ui_bridge_sources.mk",
        buildMakeSources(generatedRoot, sourceFiles, includeFolders)
    );

    for (const [relativePath, content] of generatedFiles) {
        await writeGeneratedFile(
            generatedRoot,
            generatedRootRealPath,
            relativePath,
            content
        );
    }

    await cleanupGeneratedFiles(
        projectStore,
        generatedRoot,
        generatedRootRealPath,
        previousManifest?.generatedFiles || [],
        Array.from(generatedFiles.keys())
    );

    const manifest: BridgeManifest = {
        version: BRIDGE_MANIFEST_VERSION,
        generatedFiles: Array.from(generatedFiles.keys()).sort(),
        screens: screens.map(screen => ({
            identifier: screen.identifier,
            controllerSourcePath: screen.controllerSourcePath
        }))
    };

    await writeGeneratedFile(
        generatedRoot,
        generatedRootRealPath,
        ".eez-bridge-build",
        JSON.stringify(manifest, null, 2),
    );

    writeOutput(
        projectStore,
        MessageType.INFO,
        `App/UI bridge generated in ${settings.bridgeRoot}`
    );
}
