const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../packages/project-editor/build/write-output.ts');
function writer(fsModule = fs) {
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true}
    }).outputText;
    const module = {exports: {}};
    vm.runInNewContext(compiled, {module, exports: module.exports, Buffer, require(id) {
        return id === 'fs' ? fsModule : require(id);
    }}, {filename});
    return module.exports.writeGeneratedOutput;
}
test('generated text/binary replacement is atomic, skips unchanged files and preserves old data on failure', async context => {
    const base = path.resolve(__dirname, '../../build/codegen-tests/generated-output');
    fs.mkdirSync(base, {recursive: true});
    const dir = fs.mkdtempSync(path.join(base, 'case-'));
    assert(path.relative(base, dir).startsWith('case-'));
    context.after(() => {
        for (const name of fs.readdirSync(dir)) {
            const file = path.join(dir, name);
            if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
            else fs.unlinkSync(file);
        }
        fs.rmdirSync(dir);
    });
    const file = path.join(dir, 'screens.h'), write = writer();
    await write(file, 'old\n');
    const modified = fs.statSync(file).mtimeMs;
    await write(file, 'old\n');assert.equal(fs.statSync(file).mtimeMs, modified);
    await write(file, 'new\n');assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
    await write(file, Buffer.from([0, 255, 12]));assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 255, 12]));
    const failing = writer({promises: new Proxy(fs.promises, {get(target, property) {
        if (property === 'rename') return async () => {throw Object.assign(new Error('busy'), {code: 'EPERM'});};
        return target[property];
    }})});
    await assert.rejects(failing(file, 'replacement'), /busy/);
    assert.deepEqual(fs.readFileSync(file), Buffer.from([0, 255, 12]));
    assert.deepEqual(fs.readdirSync(dir), ['screens.h']);
    const directory = path.join(dir, 'directory');fs.mkdirSync(directory);
    await assert.rejects(write(directory, 'invalid'), /non-regular/);
});
