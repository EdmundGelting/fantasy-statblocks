import {
    Component,
    Notice,
    TAbstractFile,
    TFile,
    TFolder,
    getFrontMatterInfo
} from "obsidian";
import type StatBlockPlugin from "src/main";
//have to ignore until i fix typing issue
//@ts-expect-error
import FSWorker, {
    GetFileCacheMessage,
    FileCacheMessage,
    QueueMessage,
    UpdateEventMessage,
    SaveMessage,
    DebugMessage
} from "./watcher.worker";

declare global {
    interface Worker {
        postMessage<T>(message: T, transfer?: Transferable[]): void;
    }
}

export class Watcher extends Component {
    announce: boolean;
    get metadataCache() {
        return this.plugin.app.metadataCache;
    }
    get vault() {
        return this.plugin.app.vault;
    }
    constructor(public plugin: StatBlockPlugin) {
        super();
    }

    watchPaths: Map<string, string> = new Map();

    worker: Worker = new FSWorker();
    setDebug() {
        this.worker.postMessage<DebugMessage>({
            type: "debug",
            data: this.plugin.settings.debug
        });
    }
    onload() {
        this.setDebug();
        /** Metadata for a file has changed and the file should be checked. */
        this.registerEvent(
            this.metadataCache.on("changed", async (file) => {
                if (!this.plugin.settings.autoParse) return;
                const { frontmatter } =
                    this.metadataCache.getFileCache(file) ?? {};
                if (!frontmatter || !frontmatter.statblock) {
                    if (this.watchPaths.has(file.path)) {
                        this.delete(file.path);
                    }
                    return;
                }
                if (this.plugin.settings.debug)
                    console.debug(`Fantasy Statblocks: Reparsing ${file.name}`);
                this.parsePath(file);
            })
        );
        /** A file has been renamed and should be checked for events.
         * Could this be hashed?
         */
        //TODO: Refactor
        this.registerEvent(
            this.vault.on("rename", async (abstractFile, oldPath) => {
                if (!this.plugin.settings.autoParse) return;
                if (!(abstractFile instanceof TFile)) return;
                if (!this.watchPaths.has(oldPath)) return;

                if (this.plugin.settings.debug)
                    console.debug(
                        `Fantasy Statblocks: Handling rename of ${oldPath} to ${abstractFile.path}`
                    );
                await this.delete(oldPath);
                this.parsePath(abstractFile);
            })
        );
        /** A file has been deleted and should be checked for events to unlink. */
        //TODO: Refactor
        this.registerEvent(
            this.vault.on("delete", (abstractFile) => {
                if (!this.plugin.settings.autoParse) return;
                if (!(abstractFile instanceof TFile)) return;
                if (!this.watchPaths.has(abstractFile.path)) return;
                this.delete(abstractFile.path);
            })
        );

        //worker messages
        /** The worker will ask for file information from files in its queue here */
        this.worker.addEventListener(
            "message",
            async (event: MessageEvent<GetFileCacheMessage>) => {
                if (event.data.type == "get") {
                    const data = await this.getFileInformation(event.data.data);
                    if (!data) {
                        this.worker.postMessage<Partial<FileCacheMessage>>({
                            type: "file"
                        });
                    } else {
                        this.worker.postMessage<FileCacheMessage>(data);
                    }
                }
            }
        );

        /** The worker has found an event that should be updated. */
        this.worker.addEventListener(
            "message",
            async (evt: MessageEvent<UpdateEventMessage>) => {
                if (evt.data.type == "update") {
                    let { monster, path } = evt.data.data;

                    let update = false;
                    if (this.watchPaths.has(path)) {
                        const existing = this.watchPaths.get(path);
                        await this.plugin.deleteMonster(existing);
                        update = true;
                        if (this.plugin.settings.debug)
                            console.debug(
                                `Fantasy Statblocks: Updating ${monster.name}`
                            );
                    }

                    if (
                        "monster" in monster &&
                        this.plugin.bestiary.has(monster.monster)
                    ) {
                        monster = {
                            ...this.plugin.bestiary.get(monster.monster),
                            ...monster
                        };
                    }

                    this.watchPaths.set(path, monster.name);
                    await this.plugin.saveMonster(monster, false, false);

                    if (this.plugin.settings.debug)
                        console.debug(
                            `Fantasy Statblocks: ${
                                update ? "Updated" : "Added"
                            } ${monster.name}`
                        );
                }
            }
        );

        /** The worker has parsed all files in its queue. */
        this.worker.addEventListener(
            "message",
            async (evt: MessageEvent<SaveMessage>) => {
                if (evt.data.type == "save") {
                    await this.save();
                }
            }
        );
        this.plugin.app.workspace.onLayoutReady(() => {
            for (const [_, monster] of this.plugin.settings.monsters.filter(
                ([_, monster]) => monster.note
            )) {
                if (this.watchPaths.has(monster.note)) {
                    //multiple defined for this note... delete them all
                    this.plugin.deleteMonster(monster.name);
                }
                this.watchPaths.set(monster.note, monster.name);
            }

            if (!this.plugin.settings.autoParse) return;
            this.start();
        });
    }
    async save() {
        await this.plugin.saveSettings();
        if (this.startTime) {
            console.info(
                `Fantasy Statblocks: Frontmatter Parsing Complete in ${(
                    (Date.now() - this.startTime) /
                    1000
                ).toLocaleString()} seconds.`
            );
            this.startTime = 0;
        }
        if (this.announce) {
            new Notice("Fantasy Statblocks: Frontmatter Parsing complete.");
            this.announce = false;
        }
    }
    async delete(path: string) {
        await this.plugin.deleteMonster(this.watchPaths.get(path));
        this.watchPaths.delete(path);
        if (this.plugin.settings.debug)
            console.debug(
                `Fantasy Statblocks: Removing '${path}' from bestiary`
            );
    }
    startTime: number;
    start(announce = false) {
        this.announce = announce;
        this.startTime = Date.now();
        console.info("Fantasy Statblocks: Starting Frontmatter Parsing.");
        if (!this.plugin.settings.paths?.length) {
            this.plugin.settings.paths = ["/"];
        }
        let isParsing = false;
        for (const path of this.plugin.settings.paths) {
            const folder = this.vault.getAbstractFileByPath(path);
            if (!folder) continue;
            isParsing = true;
            this.parsePath(folder);
        }
        if (!isParsing) {
            this.save();
        }
    }
    pathContainsFile(file: TAbstractFile) {
        if (
            !this.plugin.settings.paths.length ||
            this.plugin.settings.paths.contains("/")
        )
            return true;

        for (const path of this.plugin.settings.paths) {
            if (file.path.startsWith(path)) return true;
        }
        return false;
    }
    parsePath(folder: TAbstractFile) {
        if (!this.pathContainsFile(folder)) return;
        const parsing: Set<string> = new Set();
        for (const path of this.getFiles(folder)) {
            parsing.add(path);
        }
        this.startParsing([...parsing]);
    }
    startParsing(paths: string[]) {
        if (paths.length) {
            this.worker.postMessage<QueueMessage>({
                type: "queue",
                data: paths
            });
        }
    }
    async getFileInformation(path: string): Promise<FileCacheMessage | null> {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        if (this.watchPaths.has(file.path)) {
            const monster = this.plugin.bestiary.get(
                this.watchPaths.get(file.path)
            );

            if (monster && monster.mtime && monster.mtime == file.stat.mtime)
                return null;
        }

        const cache = this.plugin.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter?.statblock) return null;
        if (
            cache?.frontmatter?.statblock !== true &&
            cache?.frontmatter?.statblock !== "true" &&
            cache?.frontmatter?.statblock !== "inline"
        )
            return null;
        const content = await this.plugin.app.vault.cachedRead(file);
        const info = getFrontMatterInfo(content);

        return {
            type: "file",
            data: {
                statblock:
                    cache.frontmatter.statblock == "inline"
                        ? "inline"
                        : "frontmatter",
                content,
                info,
                file: {
                    path: file.path,
                    basename: file.basename,
                    mtime: file.stat.mtime
                }
            }
        };
    }
    getFiles(folder: TAbstractFile): string[] {
        let files = [];
        if (folder instanceof TFolder) {
            for (const child of folder.children) {
                files.push(...this.getFiles(child));
            }
        }
        if (folder instanceof TFile && folder.extension === "md") {
            files.push(folder.path);
        }
        return files;
    }
    async reparseVault() {
        for (const monster of this.watchPaths.values()) {
            this.plugin.deleteMonster(monster, false, false);
        }

        this.start(false);
    }
    onunload() {
        this.worker.terminate();
        this.worker = null;
    }
}
