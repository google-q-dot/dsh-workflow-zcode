/**
 * 作者侧 facade —— 依据本机发行版里公布的那份字符串**重建**（不是逐字拷贝）。
 *
 * 出处：`.recon/sources/zcode-cli.cjs` 里 facade 是一个拼出来的字符串
 *   yoe = spa + Tho + who + apa + cpa + lpa + kho + xho     (@7709927)
 *   voe = Tho + who + kho + xho                             (@7709963，snippet 用)
 * 各段偏移：spa @7690724、Tho @7709085、who @7692746、apa @7692853、cpa @7694538、
 *           lpa @7700269、kho @7702677、xho @7707238。
 *
 * 同一份 `yoe` 既作为虚拟文件 `workflow-facade.d.ts`（常量 `R2` @7690698）进入 TypeScript 程序
 * （第二个 rootName），也被 `yoe.trim()` 原样拼进 CreateWorkflow 的工具描述（@12452311）。
 * 所以下面这些形状就是作者真正看到的契约；改这里等于同时改编译契约与模型看到的文档。
 *
 * 编译方式（决定了下文若干禁令的**成因**）：脚本被包进
 *   async function __workflowScript__() {
 *     <你的脚本>
 *   }
 *   export {};
 * 再以 `lib:["lib.es2022.d.ts"]`、`types:[]`、`strict:true`、`noEmit:true`、
 * `module:ESNext`、`moduleResolution:Bundler`、`target:ES2022` 编译（@12251598）。
 * 因此：`declare`/`export` 非法（TS1184）、`process`/`fetch`/`fs` 找不到名字、
 * 索引访问不需要守卫（noUncheckedIndexedAccess 关）。
 *
 * ⚠ 重建说明：注释按公布文本**压缩**，但每条 API 的语义、上限、失败形态都照原文；
 * 怀疑某句时以 `.recon` 里的偏移为准。snippet（EvalWorkflowSnippet）用的是子集 `voe`：
 * 只有 args / log / files / git / world —— **没有** agent / report / phase / artifact。
 */

/* ============================ agent（spa @7690724） ============================ */

/** 一个节点：分配给某个 actor 的一项任务，产出有类型的结果。Thenable —— await 它，或用 Promise.all 做汇合。 */
declare interface Node<T> extends PromiseLike<T> {}

/**
 * actor 的角色设定：身份，创建时固定（actor 生命周期内冻结）。每个 actor 都有常规工作工具
 * （读、搜、改、跑命令）；它被允许用这些工具做什么，写在 ask 里。
 */
declare interface AgentPersona {
  /** 描述该 actor 职责的 system prompt。 */
  system?: string;
}

/**
 * 一个 actor：串行执行任务的持久会话上下文。上下文跨 ask 累积；同一 actor 上的并发 ask 按 FIFO 排队。
 */
declare interface Agent {
  /**
   * 派一项任务。T 是任务的输出值：可以是你在脚本里用**普通 interface 声明**定义的类型
   * （**不要**加 `declare` 修饰符——harness 会从类型合成运行时 schema），省略类型参数时
   * 就是最终回复文本。
   */
  ask<T = string>(instructions: string): Node<T>;
}

/**
 * 创建一个新 actor。每次调用都创建新上下文；要共享上下文就得共享这个引用。
 *
 * 名字可选，但非空名字是**身份**而不是标签：它在一次 run 内必须唯一，两个 actor 同名会让整次
 * run 失败。它还是修订后重跑时匹配缓存的键（AmendWorkflow 会导入各**具名** actor 的已完成工作），
 * 所以稳定、有意义的名字能把工作带过脚本修订。匿名 actor 合法，且永远不会复用导入的工作。
 *
 * 在 fan-out 或循环里，每个迭代都是独立 actor，因此那里的固定名字就是重复的情形：给每个迭代
 * 自己的名字（`agent("reviewer-" + file)`），或者全部匿名。循环里的字面量名字在**编译**时被报出；
 * 计算出来的名字在**运行**时（第二个元素起）失败。
 */
declare function agent(name?: string, persona?: string | AgentPersona): Agent;

/* ========================== args（Tho @7709085） ========================== */

/**
 * 本次运行的参数：启动这个 workflow 时传入的值。
 *
 * 保存到项目里的 workflow 会声明它的参数（名字、类型、是否必填、默认值）；host 在 run 开始前
 * 按声明校验调用方给的值并补默认值，所以这里拿到的永远是**完整、已校验**的一袋值。
 * inline 脚本（以及 snippet 里）它是空的。
 *
 * 它永远有定义，所以读 `args.target` 是普通属性读取，不会崩。值刻意标成 `unknown`：
 * 编译期接口不能随 workflow 变化，所以在脚本里自己收窄——`String(args.target)` 或 typeof 守卫。
 */
declare const args: Readonly<Record<string, unknown>>;

/* ============================ run（who @7692746） ============================ */

/**
 * 当前这次 run 的只读身份。
 *
 * `id` 是一次运行的稳定标识：断点续跑沿用同一个 id，所以它也是「同一次工作」的线索。
 * `resumedFrom` 只在这次 run 是由另一次 run 续跑而来时存在，值是那次原始 run 的 id。
 *
 * 脚本里可以放心地写 `const run = await world.run(...)`：局部声明会按词法作用域遮蔽这个全局，
 * 两者互不干扰。
 */
declare const run: { readonly id: string; readonly resumedFrom?: string };

/* ============================ log（who @7692746） ============================ */

/** 给用户发一条进度消息。 */
declare function log(message: string): void;

/* =========================== report（apa @7692853） =========================== */

/**
 * 在 run 还在进行时发布一条中间结果。像 log() 一样它没有返回、也没有可 await 的东西——
 * 一条发现不需要回复。
 *
 * 与 log() 不同的是它**进 journal**：恢复的 run 不会重复展示同一条，而且即使 run 失败，
 * 这些条目也会随完成通知一起送达。这正是它的意义——死于四十项任务中第十二项的 run，
 * 毕竟干完了十一项，reported item 就是这些工作活下来的方式。
 *
 * 两个上限，且都是**失败整次 run** 而不是失败这次调用（void 返回没有拒绝通道）：
 * 每次 run 至多 256 条，单条序列化后至多 32KB。上限刻意宽松——报发现，不要刷屏。
 *
 * item 必须可 JSON 序列化：普通对象、数组、字符串、数字、布尔、null。函数、class 实例、
 * Date 与 promise 会在脚本**编译**时被拒。
 *
 * 可选的第二参把条目路由到一个 dashboard artifact：传一个用 artifact.chart / table / metrics /
 * board 声明过的 preset id，这条 item 就成为该看板上多出来的一个点、一行、一格或一张卡——
 * 看板就是这个 id 上的全部条目。tag 必须是编译期字面量，且指向脚本声明的 preset
 * （声明可以写在文本任意位置，但调用时它必须已经执行过）；指向不存在的 id、或指向 file/markdown
 * artifact，会让整次 run 失败。不带 tag 的 report 行为不变：进 run 的 Results；带 tag 的两边都进。
 */
declare function report(item: unknown, artifactId?: string): void;

/* ========================= artifact（cpa @7694538） ========================= */

/** 已发布的 artifact 版本：发布时用的 id，以及这次调用铸出的版本号。 */
declare interface ArtifactRef { id: string; version: number }

/** 每种 artifact 都接受的卡片元数据。 */
declare interface ArtifactOptions {
  /** 卡片标题；默认是 id。用用户的语言写。 */
  title?: string;
  /** 一两句话，在这个 artifact 领衔卡片时显示在标题旁。 */
  description?: string;
  /** 本 run 的交付物：卡片与 run 面板以它领衔。每次 run 至多一个 id；一旦置上，后续版本保持。 */
  primary?: boolean;
}
declare interface ArtifactFileOptions extends ArtifactOptions {
  /** 覆盖按扩展名嗅探出的类型（"application/pdf"、"text/html" …）。 */
  contentType?: string;
}
/** 从 reported item 里取的一个值：item 上的点路径（"timing.after"）。 */
declare interface ArtifactField { field: string; label?: string; unit?: string }
declare interface ChartSpec extends ArtifactOptions {
  type?: "line" | "bar" | "scatter";        // 默认 "line"
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];       // 多个 = 多条序列
  scale?: "linear" | "log";                 // y 轴，默认 "linear"
  /** 参考值，画成一条横线，取第一条带该字段的 item。 */
  baseline?: ArtifactField;
}
declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  /** 标识行的字段；后来同 key 的 item 会替换该行。缺席 = 只追加。 */
  key?: string;
}
declare interface MetricsSpec extends ArtifactOptions {
  /** 每格显示"最新一条带该字段的 item"的值。 */
  metrics: ArtifactField[];
}
declare interface BoardSpec extends ArtifactOptions {
  /** 标识卡片的字段；后来同 key 的 item 移动/更新该卡。 */
  key: string;
  /** 卡片所在列的字段。 */
  status: string;
  /** 列顺序。status 不在列表里的 item 落到末尾的 "other" 列。 */
  columns: string[];
  /** 卡片标题字段（默认 key）与卡片上的附加字段。 */
  cardTitle?: string;
  detail?: ArtifactField[];
}

/**
 * 发布用户该看到的东西：run 自己的交付面，run 结束后保留。
 * 两个习惯。(1) **每次 run 都发布它的交付物**，不管用户当初要什么：子代理写的网页或 PDF 走 file()；
 * 一个答案（发现、评审）以 return 所概括事实的长文形式走 markdown()。在结尾发布一次；
 * 只有当整个答案是一行时才跳过。一次 run 发布多于一个 artifact 时，把交付物标 `{ primary: true }`。
 * (2) **看板是给盯着这次 run 的人看的**：run 中途有值得看的进展就声明一个（每轮的关键数字、
 * 哪些项已完成），run 在人看之前就结束了就别声明。两个测试足以砍掉多余的：用户会单独打开它吗？
 * 它是否重复了另一个 artifact？一个 CSV 和它的表格：其中一个是噪音。
 *
 * 每个 id 都是编译期字符串字面量（非空、至多 64 个 `[A-Za-z0-9_.-]` 字符）；一次 run 能发布什么
 * 在提交时就固定了，所以编译期会拒绝计算出来的 id。同一次 run 内一个 id 只属于一个成员。
 * 两个家族刻意不对称，而这不对称就是整个设计：
 * - **CONTENT（file、markdown）是效果**：异步，resolve 成 ArtifactRef，并且**可 catch 地 reject**
 *   ——文件不存在、不是文件、路径在工作区外、超过尺寸上限、没有 store。
 *   `try { await artifact.file("book", "out/book.pdf") } catch { …让子代理去写… }` 就是预期写法。
 *   字节在发布时被拷贝，所以之后改工作区不会改写任何版本；重发同一个 id 会铸出**下一个版本**并保留
 *   旧版本（每个 id 至多 16 个）。
 * - **PRESET（chart、table、metrics、board）是声明**：同步、不返回东西、不碰文件；它们说明
 *   "打了这个 id 的 item 该怎么画"。每个**只声明一次**，放在顶部，然后用 `report(item, "<id>")` 喂它。
 *   同 id 同 spec 是 no-op；**不同或非法的 spec 会让整次 run 失败**——void 返回没有拒绝通道，
 *   与 report() 一样。
 *
 * 上限：每次 run 32 个 id，每个 id 16 个版本，单文件 20 MiB，markdown 256 KB，
 * 标题 120 字符、描述 500 字符。
 */
declare const artifact: {
  /**
   * 从工作区发布一个文件。path 相对工作区，由 files.read() 用的同一个解析器解析；字节在发布时拷贝。
   * 内容类型取自扩展名，除非 opts.contentType 覆盖。宁可不发，也不发空内容（reject 可 catch）。
   */
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  /** 发布脚本自己拼出的 markdown 文本：报告类交付物的常见形态，是 return 所概括内容的长文形式。 */
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  /** 声明一个由 report(item, id) 喂的图：每条打 tag 的 item 是一个点。 */
  chart(id: string, spec: ChartSpec): void;
  /** 声明一个由 report(item, id) 喂的表：每条打 tag 的 item 是一行。 */
  table(id: string, spec: TableSpec): void;
  /** 声明一组指标格，由 report(item, id) 喂：每格显示它拿到的最新值。 */
  metrics(id: string, spec: MetricsSpec): void;
  /** 声明一个看板，由 report(item, id) 喂：每条打 tag 的 item 是一张卡，按 status 字段落列。 */
  board(id: string, spec: BoardSpec): void;
};

/* ============================ phase（lpa @7700269） =========================== */

/**
 * 标记一个阶段的开始：给随后那组步骤起一个简短、人读的名字，在用户阅读并批准的 workflow 图上
 * 显示为一个节点。**只影响呈现**——不启动任何东西、不等待任何东西、不返回任何东西。
 *
 * 每个提交的脚本都**必须**有：phase 图是用户体验这个 workflow 的方式。没有标记，用户面对的是
 * 每步一张卡、没有故事；自上而下把整个脚本分组。
 *
 * 用用户在这次对话里说的语言、为用户命名：一个简短自然短语，说明这个阶段完成了什么
 * （"Research each changed file in parallel"、"汇总并产出最终报告"）。用户从未选择的
 * 图构建词汇——"fan-out"、"gate"、"aggregate"——不是名字；用户按阶段做的事来批准阶段。
 * 就像你对同事说发生了什么："确认测试仍然通过"，而不是"执行测试验证任务"。
 *
 * 作用域是**所在块的剩余部分**：标记认领从它起到所在块末尾的每一步——含嵌套块与被内联的辅助
 * 调用——块结束后外层 phase 恢复。所以 `if` 分支里的标记只覆盖那个分支，不会泄漏出去。
 * 两个同名标记是**同一个** phase：重复名字是延续该 phase，这与 actor 的名字正好相反
 * （那个必须唯一）。
 *
 * 编译器强制两条：名字必须是编译期字符串字面量（"review the diff" 或无替换模板）且非空，
 * 因为 phase 名字是用户批准前看到的图的标签；调用必须**独立成语句**，处在表达式位置的标记
 * 没有"块的剩余部分"可认领。
 *
 * 每个 phase 至少要含一个子代理 ask 或一个 world.run。phase 是用户看着推进的阶段；两个 ask
 * 之间的纯脚本逻辑（读 args、拼 prompt、构造返回值）一闪而过、不显示进度，所以它不是阶段。
 * 把它并进前一个或后一个 phase；绝不要为顶部的准备或底部的返回另开一个 phase。
 *
 * 惯用法：每个真正干活的阶段头部一个标记——在循环体与其检查开始处命名它们，在循环之后
 * 发出 ask 或 run 的收尾处命名收尾。
 */
declare function phase(name: string): void;

/* ====================== files / git（kho @7702677） ====================== */

/** files.grep 找到的一行匹配。 */
declare interface GrepMatch {
  /** 命中所在文件的工作区相对路径。 */
  path: string;
  /** 从 1 开始的行号。 */
  line: number;
  /** 匹配行的全文。 */
  text: string;
}

/**
 * 工作区的 journaled 只读观察，由 harness 执行。重放返回 journal 里记录的值。
 * 优先把路径交给 agent 让它用自己的工具读；read() 和 grep() 是给"脚本自己必须按内容分片或分支"
 * 的场合用的。这里**没有写**——写世界是 agent 的任务。
 */
declare const files: {
  /**
   * 列出匹配 glob 的工作区文件，返回按字典序排序的工作区相对路径。上限 2000 个文件：
   * 超限时调用 reject 而不是返回部分视图——把 pattern 收窄。
   */
  glob(pattern: string): Promise<string[]>;
  /** 把一个工作区文件当 UTF-8 文本读。有尺寸上限。 */
  read(path: string): Promise<string>;
  /**
   * 用 ripgrep 兼容的正则搜文件内容，可选地用路径 glob 收窄（与 glob() 同样的语法："*.ts"、"src/**"）。
   * 每个匹配行返回一条，带工作区相对路径与从 1 开始的行号。
   *
   * 上限 2000 条匹配或 256KB 结果，先到先算。超限时 reject 而不是返回部分视图——静默截断的搜索
   * 是唯一没法推理的结果——所以收窄 pattern 或加一个 glob。
   */
  grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
};

/** 工作树状态，如 git.status() 所报。 */
declare interface GitStatus {
  /** 当前分支名；HEAD 脱离时缺席。 */
  branch?: string;
  /** 没有暂存、没有修改、没有未跟踪时为 true。 */
  clean: boolean;
  /** 已暂存待下次提交的工作区相对路径。 */
  staged: string[];
  /** 工作树里已改但未暂存的工作区相对路径。 */
  unstaged: string[];
  /** git 不跟踪（遵循 .gitignore）的工作区相对路径。 */
  untracked: string[];
}

/** 一次提交，如 git.log() 所报。 */
declare interface GitCommit {
  /** 完整提交哈希。 */
  hash: string;
  /** 提交信息第一行。 */
  subject: string;
  /** 作者名。 */
  author: string;
  /** 作者日期，ISO 8601。 */
  date: string;
}

/**
 * journaled 只读 git 观察——与 files.* 同样的约定：由 harness 执行、记进 journal、重放时从记录返回，
 * 所以恢复的 run 看到的是仓库**当时**的样子，而不是现在的。
 *
 * 只读是**构造上的**而不是权限上的：harness 为一个白名单子命令构造固定参数表，从不拼 shell 字符串，
 * 所以这个接口表达不出任何写操作。base 必须是一个 ref——此版本不支持 `..` 区间；路径相对工作区。
 *
 * 观察范围限定在工作区，也就是 files.* 观察的同一个世界：拿回的每个路径都相对工作区，可以直接
 * 交给 files.read()。工作区若是仓库的子目录，它之外的变化不会被报告——工作区就是世界。
 * git.log 是例外，因为提交是仓库级的对象而不是路径。
 *
 * 上限 reject 而不是截断（diff 512KB、log 100 条），理由同 grep。不在 git 仓库里、或没有 git 时，
 * 每个调用都以可 catch 的错误 reject，所以惯用法是 try/catch 配 files.glob 兜底。
 */
declare const git: {
  /**
   * 变化了的工作区相对路径。不带 base：相对 HEAD 修改的文件加上未跟踪文件，因为新文件对任何读者
   * 都是变化。带 base ref：与该 ref 不同的文件，只含已跟踪历史。
   */
  changedFiles(base?: string): Promise<string[]>;
  /** 相对 base（默认 HEAD）的统一 diff。除非收窄到一个工作区相对路径，否则覆盖整个工作区。 */
  diff(base?: string, path?: string): Promise<string>;
  /** 工作区的当前工作树状态。 */
  status(): Promise<GitStatus>;
  /** 最近的提交，新的在前。默认 20，最多 100。与其他成员不同，它读的是仓库级历史而不是路径。 */
  log(count?: number): Promise<GitCommit[]>;
};

/* ============================ world（xho @7707238） ============================ */

/** 一次 world.run 命令的结果，含非零退出码。 */
declare interface WorldRunResult {
  /** 进程退出码。非零是正常的返回值——对它分支。 */
  exitCode: number;
  /** 捕获的 stdout（UTF-8）。上限 256KB；超限时调用 reject。 */
  stdout: string;
  /** 捕获的 stderr（UTF-8）。上限与拒绝语义同 stdout。 */
  stderr: string;
}

/**
 * journaled 命令执行——效果原语。由 harness 每个调用点、每个迭代**恰好执行一次**，记进 journal，
 * 恢复时从记录重放（恢复是崩溃恢复，不是重新验证）。
 *
 * 与 git.* 刻意不同：进程跑完且退出码**非零**会 resolve 成 WorldRunResult——失败的检查是门控循环
 * 的常态，不该走异常控制流。只有命令根本无法作为一次观察运行时 promise 才可 catch 地 reject：
 * spawn 失败，或超时（默认 300000ms，可按调用用 timeoutMs 覆盖，无上限）。
 *
 * cmd 必须是编译期字符串字面量：脚本的命令集会在用户确认 run 时展示给他，只有那些命令可执行。
 * 固定 argv，从不是 shell——没有管道、没有重定向、没有变量展开；用多次调用与普通代码组合。
 * cwd 是工作区。惯用法：模型生成、代码门控——在这里跑检查、用纯脚本逻辑解析输出、把失败交给
 * agent 去修。需要 Node 内置能力的辅助逻辑可以用 world.run("node", ["-e", code]) 内联——
 * code 这段字符串活在脚本里，所以和其他参数一样被 journal 键钉住。
 */
declare const world: {
  run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult>;
};

/* ============================ 非 facade 的运行时事实（供对照，脚本里看不到） ============================
 *
 * 1) 站点与 journal：每个站点调用在 lowering 时拿到 `ask#N` / `actor#N` / `world-read#N` /
 *    `report#N` / `artifact#N`（`join#N` 分配但从不 lower）。父进程按 (run_id, site_id, ordinal)
 *    落库，ordinal = 该站点本 run 内第几次执行。见 .recon/db/schema.sql 的 dwf_node/dwf_actor。
 * 2) 运行期禁令：bootstrap 把 globalThis.Date 换成 __WorkflowDate（无参构造与 now() 抛错），
 *    并把 Math.random 覆盖成抛错。这是运行期护栏，不是编译期诊断（见 reference/compile-pipeline.md §8）。
 * 3) snippet（EvalWorkflowSnippet）用子集 facade `voe`：只有 args / log / files / git / world，
 *    并以只读方式跑（world.run 仍会问用户确认）。
 */
