import {
    NamingConvention,
    getName
} from "project-editor/build/helper";
import type { Page } from "project-editor/features/page/page";

export function getLvglScreenIdentifier(page: Page) {
    return getName("", page, NamingConvention.UnderscoreLowerCase);
}
