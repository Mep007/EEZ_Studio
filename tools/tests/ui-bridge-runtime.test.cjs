const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const ts = require('typescript');

test('compile and execute the generated engine lifecycle in C', context => {
    const compiler = process.env.CC || (process.platform === 'win32' ? 'cl' : 'cc');
    if (spawnSync(compiler, ['--version']).error?.code === 'ENOENT') {
        context.skip('Run in a C compiler environment to execute generated C');
        return;
    }
    const filename = path.resolve(__dirname, '../../packages/project-editor/lvgl/app-ui-bridge-codegen.ts');
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(js + '\nexports.testEngine = {buildEngineSource, buildEngineHeader};', {
        exports: module.exports, module,
        require(id) { if (id === 'fs') return fs; if (id === 'path') return path; return {}; }
    }, { filename });
    const output = path.resolve(__dirname, '../../build/codegen-tests/ui-engine');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'ui_engine.generated.c'), module.exports.testEngine.buildEngineSource());
    fs.writeFileSync(path.join(output, 'ui_engine.generated.h'), module.exports.testEngine.buildEngineHeader());
    for (const header of ['screens.h', 'ui_bridge_config.generated.h', 'ui_message_bus.generated.h', 'ui_screen_registry.generated.h']) {
        fs.writeFileSync(path.join(output, header), '#include "test_runtime.h"\n');
    }
    const fixture = path.resolve(__dirname, 'ui-engine');
    const exe = path.join(output, process.platform === 'win32' ? 'test.exe' : 'test');
    const msvc = /(^|[\\/])cl(\.exe)?$/i.test(compiler);
    const args = msvc ? ['/nologo', '/std:c11', `/I${output}`, `/I${fixture}`,
        `/Fo${output}/`, `/Fe${exe}`, path.join(fixture, 'test_engine.c'), path.join(output, 'ui_engine.generated.c')] :
        ['-std=c11', '-I' + output, '-I' + fixture, path.join(fixture, 'test_engine.c'),
            path.join(output, 'ui_engine.generated.c'), '-o', exe];
    const built = spawnSync(compiler, args, { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const ran = spawnSync(exe, [], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    context.diagnostic(ran.stdout.trim());
});
