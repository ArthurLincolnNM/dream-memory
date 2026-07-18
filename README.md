# Dream Memory

Memória persistente para o Pi. Lembra o que você prefere, o que aprendeu, e o que deu errado.

## Instalação

```bash
cp -r ~/.pi/agent/extensions/dream-memory/ ~/.pi/agent/extensions/
```

## O que faz sozinho (você não precisa rodar nada)

- **Lembra automaticamente** — antes de cada resposta, busca memórias relevantes e injeta no contexto
- **Aprende padrões** — se você rodar `npm test` 5 vezes iguais, salva como memória
- **Consolida de tempos em tempos** — junta memórias similares, remove expiradas
- **Limpa o disco** — apaga backups antigos (a cada 7 dias)
- **Esquece coisas velhas** — memórias com prazo expiram (ex: debug de bug = 7 dias)
- **Filtra senhas** — se você colar uma API key por engano, é censurada antes de salvar

## Comandos (use só quando quiser)

| Comando | Quando usar |
|---------|-------------|
| `/dream` | Consolidar agora (esperar o automático é chato) |
| `/dream-accept` | Aceitar as mudanças que o `/dream` propôs |
| `/dream-discard` | Descartar as mudanças (manter original) |
| `/dream-list` | Ver o que tá salvo |
| `/dream-cleanup` | Limpar arquivos velhos (já é automático, mas pode forçar) |
| `/dream-purge` | Apagar memórias temporárias (as que têm prazo) |
| `/dream-doctor` | "Tá tudo funcionando?" |
| `/dream-metrics` | Estatísticas detalhadas (quantas buscas, recalls, etc) |
| `/dream-status` | Widget com totais (memórias, expiradas, escopo) |
| `/dream-popup` | Mostra a última recall injetada |
| `/dream-eval` | Roda regression suite do recall |
| `/dream-doctor` | Diagnóstico de saúde |
| `/dream-metrics` | Estatísticas detalhadas |
| `/distill` | Gerar "skills" a partir de padrões de comandos repetidos |

## Tools (o agente usa, mas você pode pedir)

| Tool | Pra quê |
|------|---------|
| `dream_memory_add` | Salvar uma memória manualmente |
| `dream_memory_search` | Buscar memórias |
| `dream_memory_list` | Listar com filtros |
| `dream_memory_update` | Editar uma memória existente (conteúdo/categoria/status) |
| `dream_memory_stats` | Ver totais |
| `dream_memory_history` | Ver histórico de versões de uma memória |
| `dream_memory_rollback` | Reverter batch ou versão específica |

## Tipos de memória (o `category`)

O agente recebe o schema completo (descrição canônica + examples) no promptSnippet do `dream_memory_add` e `dream_memory_search`. Adicionar uma category nova é uma linha em `utils/constants.ts` e o prompt atualiza sozinho.

- `preference` — gosto seu (ex: "prefere vim")
- `convention` — padrão do projeto (ex: "usa 2 espaços")
- `insight` — conclusão derivada (ex: "user prefere X para Y")
- `failure` — o que deu errado
- `correction` — conserto
- `tool-quirk` — comportamento estranho de ferramenta

### Targets (o quê a memória é SOBRE)

- `user` — sobre você (preferências, workflow, estilo)
- `project` — sobre o código/produto (estrutura, deps, arquitetura)
- `failure` — sobre uma falha específica (o evento)
- `memory` — meta-memória (raro, reflexão do agente)

Princípio 10/10/10: 4 targets + 6 categories = 10 tipos no cap. Resista a adicionar mais — se não encaixa em nenhum, escolha o mais próximo e descreva bem no `content`.

## Quanto tempo dura (o `ttl`)

| Valor | Duração | Exemplo |
|-------|---------|---------|
| `permanent` | Pra sempre | "user usa vim" |
| `long` | 1 ano | "projeto usa Postgres" |
| `medium` | 30 dias | "build com flag X" |
| `short` | 7 dias | "debugando bug Y" |
| `session` | 1 dia | "o que tô fazendo agora" |

## Escopos (onde a memória vale)

| Scope | Onde aparece |
|-------|--------------|
| `global` | Em qualquer projeto |
| `project` | Só neste projeto |
| `agent` | Só com este agente |
| `session` | Só nesta sessão |

O sistema detecta automaticamente. Você não precisa se preocupar.

## Settings (só se quiser ajustar)

Crie `~/.pi/agent/dream-memory.json`:

```json
{
  "cleanup": {
    "enabled": true,
    "maxAgeMs": 604800000
  },
  "recall": {
    "maxTokens": 4000
  }
}
```

- `cleanup.maxAgeMs` (padrão: 7 dias) — quão velho um arquivo precisa estar pra ser auto-apagado
- `recall.maxTokens` (padrão: 4000) — quanto contexto o sistema usa pra injetar memórias

## Development

```bash
# Install deps (uses npm; better-sqlite3 builds its native binding automatically)
npm install

# Run unit tests (63 tests across 9 files, ~250ms)
npm test

# Typecheck
npm run typecheck
```

## Problemas comuns

**Memória não tá sendo encontrada:**
Rode `/dream-doctor` e veja se tem erro. Se não, diminua `recall.maxTokens` não, isso não ajuda. Tente `/dream-list` pra ver o que existe.

**Disco cheio:**
`/dream-cleanup` (ou espere o automático).

**Quero resetar tudo:**
`/dream-purge` apaga memórias temporárias. Pra apagar TUDO, delete a pasta `~/.pi/agent/dream-memory/`.

**Auto-dream não roda:**
Espera — só roda após 7 dias + 5 sessões desde o último. Pra forçar: `/dream`.

## Licença

MIT.
