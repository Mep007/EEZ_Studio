import os from "os";
import path from "path";

import { MEP_FORK_APP_NAME } from "eez-studio-shared/mep-fork";
import { sourceRootDir } from "eez-studio-shared/util";

export function getIcon() {
    if (os.platform() == "win32") {
        return path.resolve(`${sourceRootDir()}/../icon.ico`);
    } else {
        return path.resolve(
            `${sourceRootDir()}/eez-studio-ui/_images/eez_studio_logo.png`
        );
    }
}

export const APP_NAME = MEP_FORK_APP_NAME;
