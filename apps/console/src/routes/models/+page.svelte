<script lang="ts">
  let { data, form } = $props();
  const active = $derived(data.models.find((m: { active: boolean }) => m.active));
</script>

<h1>Models</h1>

<form method="GET">
  <input name="application" value={data.application} placeholder="Application, e.g. crm-prod" aria-label="Application" required />
  <button type="submit">Show</button>
</form>

{#if form && "error" in form}
  <p role="alert">{form.error}</p>
{:else if form && "message" in form}
  <p role="status">
    {form.message}
    {#if form.auditEventId}Audit event {form.auditEventId}.{/if}
  </p>
{/if}

{#if data.application}
  <h2>History: {data.application}</h2>
  {#if data.models.length === 0}
    <p>No models.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Model</th><th>Bound</th><th>State</th><th></th></tr>
      </thead>
      <tbody>
        {#each data.models as m (m.id)}
          <tr>
            <td>{m.id}</td>
            <td>{m.createdAt}</td>
            <td>{m.active ? "Active" : "Prior"}</td>
            <td>
              {#if active && !m.active}
                <a href={`?${new URLSearchParams({ application: data.application, from: m.id, to: active.id })}`}>Compare with active</a>
                {#if data.canWrite}
                  <form method="POST" action="?/rollback">
                    <input type="hidden" name="application" value={data.application} />
                    <input type="hidden" name="modelId" value={m.id} />
                    <details>
                      <summary>Roll back</summary>
                      <button type="submit" name="confirm" value="yes">Confirm roll back to {m.id}</button>
                    </details>
                  </form>
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if data.nextCursor}
    <a href={`?${new URLSearchParams({ application: data.application, cursor: data.nextCursor })}`}>Next page</a>
  {/if}

  {#if data.diff}
    <h2>{data.diff.from} to {data.diff.to}</h2>
    <pre aria-label="Model diff">{#each data.diff.lines as line}<span class={line.kind}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}</span>
{/each}</pre>
  {/if}
{/if}

<style>
  .add { color: green; }
  .del { color: crimson; }
</style>
