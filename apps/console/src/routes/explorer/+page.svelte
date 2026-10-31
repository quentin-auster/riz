<script lang="ts">
  let { form } = $props();
</script>

<h1>Access explorer</h1>
<p>Can a principal hold a relation on an object? Answered queries are audited.</p>

<form method="POST" action="?/check">
  <input name="application" value={form?.query?.application ?? ""} placeholder="Application, e.g. crm-prod" aria-label="Application" required />
  <input name="principal" value={form?.query?.principal ?? ""} placeholder="Principal, e.g. anne" aria-label="Principal" required />
  <input name="relation" value={form?.query?.relation ?? ""} placeholder="Relation, e.g. read" aria-label="Relation" required />
  <input name="object" value={form?.query?.object ?? ""} placeholder="Object, e.g. document:d1" aria-label="Object" required />
  <button type="submit">Check</button>
</form>

{#if form && "error" in form}
  <p role="alert">{form.error}</p>
{:else if form && "answer" in form}
  <dl role="status">
    <dt>Decision</dt>
    <dd>{form.answer.status}</dd>
    <dt>Model</dt>
    <dd>{form.answer.modelId ?? "None"}</dd>
    <dt>Request</dt>
    <dd>{form.answer.requestId}</dd>
    {#if form.answer.code}
      <dt>Reason</dt>
      <dd>{form.answer.code}</dd>
    {/if}
  </dl>
{/if}
