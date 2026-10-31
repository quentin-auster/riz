<script lang="ts">
  let { data, children } = $props();
</script>

<header>
  <strong>riz</strong>
  {#if data.subject}
    <nav>
      <a href="/">Home</a>
      <a href="/applications">Applications</a>
    </nav>
    <form method="POST" action="/logout">
      <span>{data.subject}</span>
      <button type="submit">Sign out</button>
    </form>
  {/if}
</header>
<main>{@render children()}</main>
