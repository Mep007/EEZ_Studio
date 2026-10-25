const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

class Build {
    startBuild() { this.result = ''; this.indentation = ''; }
    line(text) { this.result += this.indentation + text + '\n'; }
    blockStart(text) { this.line(text); this.indentation += '    '; }
    blockEnd(text) { this.indentation = this.indentation.slice(4); this.line(text); }
}
class Widget {
    constructor(identifier, page, parent) {
        this.identifier = identifier;
        this.objID = 'id' + Widget.next++;
        this.page = page;
        this.children = [];
        if (parent) {
            parent.children.push(this);
            this.parent = parent.children;
            this.parent.parent = parent;
        }
    }
}
Widget.next = 0;
class Screen extends Widget {}
class Page {}
class UserWidget extends Widget {
    constructor(identifier, page, parent, definition) {
        super(identifier, page, parent);
        this.userWidgetPage = definition;
        this.isCycleDetected = false;
    }
}
const name = value => String(value).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const projectEditor = {
    PageClass: Page,
    LVGLWidgetClass: Widget,
    LVGLScreenWidgetClass: Screen,
    LVGLUserWidgetWidgetClass: UserWidget,
    getPage: widget => widget.page,
    getFlow: widget => widget.page
};
const sourceFile = path.resolve(__dirname, '../../packages/project-editor/lvgl/build.ts');
const moduleStub = { exports: {} };
const js = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
vm.runInNewContext(js, {
    exports: moduleStub.exports, module: moduleStub, console,
    require(id) {
        if (id === 'fs') return fs;
        if (id === 'path') return path;
        if (id === 'project-editor/build/helper') return {
            Build, USER_WIDGET_IDENTIFIER_SEPARATOR: '__', NamingConvention: {},
            getName: (prefix, value) => prefix + name(value)
        };
        if (id === 'project-editor/project-editor-interface') return { ProjectEditor: projectEditor };
        if (id === 'project-editor/core/object') return { getParent: object => object.parent, MessageType: {} };
        if (id === 'project-editor/lvgl/screen-codegen-helpers') return { getLvglScreenIdentifier: page => name(page.name) };
        if (id === './identifiers') return { GENERATED_NAME_PREFIX: 'obj' };
        return {};
    }
}, { filename: sourceFile });
const { LVGLBuild } = moduleStub.exports;

function page(name, user = false) {
    const page = Object.assign(new Page(), { name, isUsedAsUserWidget: user });
    if (!user) page.lvglScreenWidget = new Screen(name, page);
    return page;
}
function identifiers() {
    return { identifiers: [], entries: [], objectStructRoots: new Map(),
        widgetToIdentifier: new Map(), widgetToAccessor: new Map(), widgetToIndex: new Map() };
}
function createBuild(pages, fromPage, fromUserWidgets, nested = true, flow = false) {
    const build = Object.create(LVGLBuild.prototype);
    const project = { settings: { build: { screenObjectStructs: nested }, general: { lvglVersion: '9.5.0' } },
        projectTypeTraits: { hasFlowSupport: flow }, lvglGroups: { groups: [] },
        _store: { lvglIdentifiers: { pages, userPages: pages.filter(p => !p.isUsedAsUserWidget) } } };
    Object.assign(build, { project, isFirstPass: false, stateVars: new Map(), pagesWithStateVars: [],
        globalVars: [], functions: {}, updateColorCallbacks: [],
        assets: { map: { lvglWidgetGeneratedIdentifiers: {} }, projectStore: {
            project, outputSectionsStore: { write(...args) { throw Error(args.join(' ')); } } } },
        lvglObjectsAccessibleFromSourceCode: { fromPage, fromUserWidgets },
        lvglObjectIdentifiers: { fromPage: identifiers(), fromUserWidgets: new Map() } });
    build.finalizeObjectAccessibleFromSourceCodeTable();
    return build;
}
function offsets(build) {
    const result = new Map();
    function walk(node) {
        for (const field of node.fields) {
            if (field.childNode) walk(field.childNode);
            else result.set(`${node.accessorPrefix}.${field.identifier}`, result.size);
        }
    }
    for (const page of build.userPages) walk(build.lvglObjectIdentifiers.fromPage.objectStructRoots.get(page));
    return result;
}

test('repeated UserWidgets reserve disjoint spans before instance-owned children', async () => {
    const main = page('main'), config = page('config'), button = page('button', true);
    const container = new Widget('container', button);
    const led = new Widget('led', button, container), label = new Widget('label', button, container);
    const a = new UserWidget('quick1', main, main.lvglScreenWidget, button);
    const ownIcon = new Widget('icon', main, a);
    const b = new UserWidget('quick2', main, main.lvglScreenWidget, button);
    const tail = new Widget('tail', main, main.lvglScreenWidget);
    const build = createBuild([main, config, button], [main.lvglScreenWidget, a, ownIcon, b, tail, config.lvglScreenWidget],
        new Map([[button, [container, led, label]]]));
    const layout = offsets(build);
    for (const instance of [a, b]) {
        const root = build.getLvglObjectAccessor(instance).slice(0, -4);
        const start = build.getWidgetObjectIndex(instance) + 1;
        assert.equal(layout.get(root + '.user_widget.container'), start);
        assert.equal(layout.get(root + '.user_widget.led'), start + 1);
        assert.equal(layout.get(root + '.user_widget.label'), start + 2);
    }
    assert.equal(build.getWidgetObjectIndex(ownIcon), 5);
    assert.equal(build.getWidgetObjectIndex(tail), 10);
    assert.equal(build.getWidgetObjectIndex(config.lvglScreenWidget), 11);
    const header = await build.buildScreensDecl();
    assert.match(header, /quick1_user_widget_objects_t user_widget;/);
    assert.match(header, /quick2_user_widget_objects_t user_widget;/);
    assert.match(header, /lv_obj_t \*led;/);
});

test('recursive UserWidget instances include all inner pointer slots', () => {
    const main = page('main'), inner = page('inner', true), outer = page('outer', true);
    const value = new Widget('value', inner);
    const group = new Widget('group', outer);
    const nested = new UserWidget('nested', outer, group, inner);
    const caption = new Widget('caption', outer, group);
    const instance = new UserWidget('outer', main, main.lvglScreenWidget, outer);
    const tail = new Widget('tail', main, main.lvglScreenWidget);
    const build = createBuild([main, inner, outer], [main.lvglScreenWidget, instance, tail],
        new Map([[inner, [value]], [outer, [group, nested, caption]]]));
    const layout = offsets(build);
    assert.equal(layout.get('objects.main.outer.user_widget.nested__value'), 4);
    assert.equal(build.getWidgetObjectIndex(tail), 6);
    assert.equal(build.lvglObjectIdentifiers.fromUserWidgets.get(outer).widgetToIndex.get(caption), 3);
});

test('anonymous and empty UserWidgets have valid storage without zero-sized C structs', () => {
    const main = page('main'), empty = page('empty', true);
    const instance = new UserWidget('', main, main.lvglScreenWidget, empty);
    const build = createBuild([main, empty], [main.lvglScreenWidget, instance], new Map([[empty, []]]));
    assert.equal(build.getWidgetObjectIndex(instance), 1);
    assert.equal(offsets(build).size, 2);
});

test('forward discovery uses the final C layout rather than visitation order', () => {
    const main = page('main');
    const left = new Widget('left', main, main.lvglScreenWidget);
    const label = new Widget('label', main, left);
    const right = new Widget('right', main, main.lvglScreenWidget);
    const other = new Widget('label', main, right);
    const build = createBuild([main], [main.lvglScreenWidget, left, right, other, label], new Map());
    assert.equal(build.getWidgetObjectIndex(label), 2);
    assert.equal(build.getWidgetObjectIndex(right), 3);
    assert.equal(build.getWidgetObjectIndex(other), 4);
});

test('legacy flat UserWidget indices and names stay unchanged', () => {
    const main = page('main'), button = page('button', true);
    const label = new Widget('label', button);
    const a = new UserWidget('quick1', main, main.lvglScreenWidget, button);
    const b = new UserWidget('quick2', main, main.lvglScreenWidget, button);
    const build = createBuild([main, button], [main.lvglScreenWidget, a, b], new Map([[button, [label]]]), false);
    assert.equal(build.getWidgetObjectIndex(a), 1);
    assert.equal(build.getWidgetObjectIndex(b), 3);
    assert.equal(build.getLvglObjectAccessor(a), 'objects.quick1');
    assert.equal(build.lvglObjectIdentifiers.fromPage.identifiers.join(','), 'main,quick1,quick1__label,quick2,quick2__label');
});

test('reject nested Flow tables instead of generating unsafe runtime indices', () => {
    const main = page('main');
    assert.throws(() => createBuild([main], [main.lvglScreenWidget], new Map(), true, true),
        /EEZ Flow disabled/);
    const flat = createBuild([main], [main.lvglScreenWidget], new Map(), false, true);
    assert.equal(flat.getWidgetObjectIndex(main.lvglScreenWidget), 0);
});

test('duplicate local names in reusable widget containers still produce valid C fields', () => {
    const main = page('main'), button = page('button', true);
    const left = new Widget('left', button), right = new Widget('right', button);
    const a = new Widget('value', button, left), b = new Widget('value', button, right);
    const instance = new UserWidget('quick', main, main.lvglScreenWidget, button);
    const build = createBuild([main, button], [main.lvglScreenWidget, instance],
        new Map([[button, [left, a, right, b]]]));
    const layout = offsets(build);
    assert.equal(layout.get('objects.main.quick.user_widget.value'), 3);
    assert.equal(layout.get('objects.main.quick.user_widget.value_1'), 5);
    assert.equal(build.lvglObjectIdentifiers.fromUserWidgets.get(button).widgetToIndex.get(b), 3);
});

test('editor object path preview uses the UserWidget root pointer, not its struct', () => {
    const filename = path.resolve(__dirname, '../../packages/project-editor/lvgl/widgets/Base.tsx');
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const names = ['getParentLvglWidget', 'getLvglCodeIdentifier', 'getLvglGeneratedObjectPath'];
    const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
    assert.equal(functions.length, names.length);
    const code = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const context = {
        ProjectEditor: projectEditor, getParent: object => object.parent,
        getProjectStore: () => ({ project: { settings: { build: { screenObjectStructs: true } } } }),
        getName: (prefix, value) => prefix + name(value), NamingConvention: {}
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    const main = page('main'), button = page('button', true);
    const instance = new UserWidget('quick', main, main.lvglScreenWidget, button);
    assert.equal(context.getLvglGeneratedObjectPath(instance), 'objects.main.quick.obj');
});

test('native boolean UserWidget inputs pass literals, live getters and outer inputs', () => {
    const main = page('main'), button = page('button', true), outer = page('outer', true);
    button.userProperties = [
        {id:'toggle', name:'show_toggle', type:'boolean'},
        {id:'mute', name:'show_mute', type:'boolean'},
        {id:'name', name:'label', type:'string'},
    ];
    outer.userProperties = [{id:'visible', name:'enabled', type:'boolean'}];
    const instance = new UserWidget('quick', main, main.lvglScreenWidget, button);
    instance.userWidgetPageName = 'button';
    instance.userPropertyValues = {values:{toggle:'true', mute:'aux_muted'}};
    const build = createBuild([main, button, outer], [main.lvglScreenWidget, instance], new Map([[button, []], [outer, []]]));
    build.project.variables = {globalVariables:[{name:'aux_muted',type:'boolean'}]};
    build.currentPage = main;
    assert.equal(build.getNativeUserWidgetParams(button), ', bool prop_show_toggle, bool prop_show_mute');
    assert.equal(build.getUserWidgetStateParam(instance), ', true, get_var_aux_muted()');
    assert.equal(build.getNativeBooleanPropertyValue(button, '!show_mute'), '!prop_show_mute');
    assert.equal(build.getNativeBooleanPropertyValue(main, 'show_mute'), undefined);
    build.currentPage = outer;
    instance.userPropertyValues.values.toggle = 'enabled';
    instance.userPropertyValues.values.mute = '!enabled';
    assert.equal(build.getUserWidgetStateParam(instance), ', prop_enabled, !prop_enabled');
    instance.userPropertyValues.values.toggle = 'true || unexpected()';
    assert.throws(() => build.getUserWidgetStateParam(instance), /Unsupported native boolean property/);
    build.project.projectTypeTraits.hasFlowSupport = true;
    assert.equal(build.getNativeUserWidgetParams(button), '');
    assert.equal(build.getNativeBooleanPropertyValue(button, '!show_mute'), undefined);
    assert.equal(build.getUserWidgetStateParam(instance), '');
});
