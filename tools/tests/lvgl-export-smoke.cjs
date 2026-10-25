const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const source = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node tools/tests/lvgl-export-smoke.cjs <native-project.eez-project>');
const project = JSON.parse(fs.readFileSync(source, 'utf8'));
assert.equal(project.settings.general.flowSupport, false, 'Use a native LVGL project');
const sandbox = path.join(root, 'build/codegen-tests/export');
fs.mkdirSync(sandbox, { recursive: true });
const build = project.settings.build;
build.destinationFolder = path.join(sandbox, 'ui');
build.screenObjectStructs = true;
build.generateAppUiBridge = true;
build.appUiBridgeOutputFolder = path.join(sandbox, 'ui_app');
build.appUiBridgeApplicationOutputFolder = path.join(sandbox, 'app');
for (const font of project.fonts || []) {
    if (font.source?.filePath) {
        font.source.filePath = path.resolve(path.dirname(source), font.source.filePath);
    }
}
const fixture = path.join(sandbox, 'fixture.eez-project');
fs.writeFileSync(fixture, JSON.stringify(project, null, 2));
for (const name of ['screens.h', 'screens.c']) {
    fs.rmSync(path.join(build.destinationFolder, name), { force: true });
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.EEZ_SMOKE_EXECUTABLE || require('electron');
const result = spawnSync(executable, [
    `--user-data-dir=${path.join(sandbox, 'profile')}`,
    ...(process.env.EEZ_SMOKE_EXECUTABLE ? [] : [root]),
    '--build-project', fixture
], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
const log = (result.stdout || '') + (result.stderr || '');
fs.writeFileSync(path.join(sandbox, 'export.log'), log);
assert.ifError(result.error);
assert.equal(result.status, 0, log);
assert(!/Unhandled error:|\b[1-9]\d* errors?\b/i.test(log), log);
const header = fs.readFileSync(path.join(build.destinationFolder, 'screens.h'), 'utf8');
const code = fs.readFileSync(path.join(build.destinationFolder, 'screens.c'), 'utf8');
const types = new Map();
for (const match of header.matchAll(/typedef struct _\w+ \{([^}]+)\}\s+(\w+);/g)) {
    const fields = [];
    for (const field of match[1].matchAll(/^\s*(\w+)\s+(\*?)(\w+);/gm)) {
        fields.push({ type: field[1], pointer: field[2] === '*', name: field[3] });
    }
    types.set(match[2], fields);
}
const slots = [];
function flatten(type, prefix = '') {
    assert(types.has(type), `Unknown object type: ${type}`);
    for (const field of types.get(type)) {
        const accessor = prefix + field.name;
        if (field.pointer) {
            assert.equal(field.type, 'lv_obj_t');
            slots.push(accessor);
        } else {
            flatten(field.type, accessor + '.');
        }
    }
}
flatten('objects_t');
assert(slots.length > 0);
const spans = new Map();
slots.forEach((accessor, index) => {
    const marker = accessor.indexOf('.user_widget.');
    if (marker !== -1) {
        const instance = accessor.slice(0, marker);
        if (!spans.has(instance)) spans.set(instance, { start: index, length: 0 });
        spans.get(instance).length++;
    }
});
const calls = [...code.matchAll(/\bcreate_user_widget_(\w+)\(obj,\s*(\d+)(?:,\s*[^;]+)?\);/g)];
assert.equal(calls.length, spans.size, 'Each instance needs its own contiguous storage');
for (const call of calls) {
    const start = Number(call[2]);
    const span = [...spans.values()].find(value => value.start === start);
    assert(span, `Missing instance storage at slot ${start}`);
    const body = code.split(`void create_user_widget_${call[1]}(`)[1]?.split(/\n(?:void|static) /)[0];
    assert(body, `Missing definition: ${call[1]}`);
    const offsets = [...body.matchAll(/\[startWidgetIndex \+ (\d+)\]/g)].map(match => Number(match[1]));
    assert(offsets.length > 0);
    assert.equal(Math.max(...offsets) + 1, span.length, 'Definition must fit its instance span exactly');
}
for (const match of code.matchAll(/\(\(lv_obj_t \*\*\)&objects\)\[(\d+)\]/g)) {
    assert(Number(match[1]) < slots.length, 'Theme/object index is outside objects_t');
}
fs.writeFileSync(path.join(sandbox, 'lvgl.h'), [
    '#include <stdint.h>',
    'typedef struct lv_obj_t lv_obj_t;',
    'typedef int lv_screen_load_anim_t;',
    'typedef uint32_t lv_color_t;', ''
].join('\n'));
fs.writeFileSync(path.join(sandbox, 'layout.c'), [
    '#include <stddef.h>', '#include "ui/screens.h"',
    `_Static_assert(sizeof(objects_t) == ${slots.length} * sizeof(lv_obj_t *), "object table size");`,
    ...slots.map((accessor, index) => `_Static_assert(offsetof(objects_t, ${accessor}) == ${index} * sizeof(lv_obj_t *), "slot ${index}");`),
    'int main(void) { return 0; }', ''
].join('\n'));
const compiler = process.platform === 'win32' ? 'cl' : 'cc';
const args = process.platform === 'win32'
    ? ['/nologo', '/std:c11', '/I.', 'layout.c', '/Fe:layout.exe']
    : ['-std=c11', '-I.', 'layout.c', '-o', 'layout'];
const compile = spawnSync(compiler, args, { cwd: sandbox, windowsHide: true, encoding: 'utf8' });
assert.ifError(compile.error);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);
console.log(`Export passed: ${slots.length} pointer slots, ${spans.size} UserWidget instances, compiled C offsets verified.`);
console.log(`Artifacts: ${sandbox}`);
