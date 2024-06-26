<script lang="ts">
    import type { Monster } from "index";
    import { Notice } from "obsidian";
    import type { BasicItem, Layout } from "src/layouts/layout.types";

    import { getContext } from "svelte";

    import DiceRoll from "./DiceRoll.svelte";
    import TextContent from "./TextContent.svelte";
    import { parseForDice } from "src/parser/dice-parsing";
    import type StatBlockPlugin from "src/main";
    import type { Writable } from "svelte/store";

    export let property: string;

    let item = getContext<BasicItem>("item");

    let dice = getContext<boolean>("dice") && item.dice;
    const monsterStore = getContext<Writable<Monster>>("monster");
    let monster = $monsterStore;
    monsterStore.subscribe((m) => (monster = m));
    let layout = getContext<Layout>("layout");
    let plugin = getContext<StatBlockPlugin>("plugin");

    let split: Array<{ text: string; original?: string } | string> = [property];

    if (plugin.canUseDiceRoller) {
        if (dice) {
            if (
                item.diceProperty &&
                item.diceProperty in monster &&
                typeof monster[item.diceProperty] == "string"
            ) {
                split = [{ text: monster[item.diceProperty] as string }];
            } else {
                const parsed = parseForDice(layout, property, monster);

                if (Array.isArray(parsed)) {
                    split = parsed;
                } else {
                    split = [parsed];
                }
            }
        }
        if (item.diceCallback?.length) {
            try {
                const frame = document.body.createEl("iframe");
                const funct = (frame.contentWindow as any).Function;
                const func = new funct(
                    "monster",
                    "property",
                    item.diceCallback
                );
                const parsed =
                    func.call(undefined, monster, property) ?? property;
                document.body.removeChild(frame);
                if (Array.isArray(parsed)) {
                    split = parsed;
                } else {
                    split = [parsed];
                }
            } catch (e) {
                new Notice(
                    `There was an error executing the provided dice callback for [${item.properties.join(
                        ", "
                    )}]\n\n${e.message}`
                );
                console.error(e);
            }
        }
    }
</script>

{#if !plugin.canUseDiceRoller || (!dice && !item.diceCallback?.length)}
    <span class="property-text">
        <TextContent textToRender={property} />
    </span>
{:else}
    {#each split as test}
        {#if typeof test != "string" && typeof test == "object" && "text" in test}
            <DiceRoll
                text={test?.text ?? property}
                original={test?.original ?? test?.text ?? property}
            />
        {:else}
            <span class="property-text">
                <TextContent textToRender={test} />
            </span>
        {/if}
    {/each}
{/if}

<style>
    .property-text {
        display: inline;
        white-space: pre-line;
        text-indent: 0;
    }
    .property-text {
        display: inline;
        margin: 0;
    }
</style>
