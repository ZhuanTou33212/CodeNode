package local.codenode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * 生成 "Minecraft 1.21 客户端启动链路" 蓝图工程文件（.cnode，MARKDOWN 模式）。
 *
 * 数据来源：E:\teaCraft\Minecraft_sourceFile\net\minecraft\client\main\Main.class
 * 用 javap -p -c 反汇编 public static void main(String[]) 后，追踪
 * invokestatic / invokevirtual / invokespecial / invokedynamic 调用指令，
 * 递归构建启动阶段的调用链；混淆类按 Minecraft 1.21 已知启动流程 + 调用上下文标注可读语义。
 *
 * 运行：mvnw.cmd test-compile 后
 *   java -cp target/classes;target/test-classes local.codenode.TeaCraftStartupChainGenerator
 */
public final class TeaCraftStartupChainGenerator {

    private TeaCraftStartupChainGenerator() {}

    record NodeSpec(String id, String name, String prompt) {}

    private static final NodeSpec[] SPECS = {
        new NodeSpec("n1", "入口与启动计时初始化",
            "Main.main 入口：创建两个启动秒表（Ticker.systemTicker -> Stopwatch.createStarted x2），" +
            "并调用 fzr.a(fzn.z, stopwatch) / fzr.a(fzn.A, stopwatch) 标记启动阶段（fzr=启动阶段计时器，fzn=阶段键）。"),
        new NodeSpec("n2", "引导静态初始化（Bootstrap）",
            "调用 aa.a()（Bootstrap 数据引导）与 aa.d()（引导校验/准备），" +
            "完成游戏引导前的静态数据初始化（aa=引导类，字段为 public static final 常量群）。"),
        new NodeSpec("n3", "命令行参数解析（joptsimple）",
            "OptionParser 注册全部启动选项：demo/disableMultiplayer/disableChat/fullscreen/checkGlErrors/jfrProfile、" +
            "quickPlayPath/quickPlaySingleplayer/quickPlayMultiplayer/quickPlayRealms、" +
            "gameDir(默认 .)/assetsDir/resourcePackDir(默认 resourcepacks/)/assetIndex、" +
            "proxyHost/proxyPort(默认8080)/proxyUser/proxyPass、" +
            "username/uuid/xuid/clientId/accessToken(必填)/userProperties/profileProperties、" +
            "width(默认854)/height(默认480)/fullscreenWidth/fullscreenHeight/version(必填)/versionType(默认release)。" +
            "随后 OptionParser.parse(args) 得到 OptionSet。"),
        new NodeSpec("n4", "网络代理与认证配置",
            "读取 proxyHost/proxyPort 构造 java.net.Proxy(SOCKS, InetSocketAddress)；" +
            "若 proxyUser/proxyPass 均非空则创建 Main$1(Authenticator) 并调用 Authenticator.setDefault，为网络访问配置代理认证。"),
        new NodeSpec("n5", "窗口与功能标志解析",
            "从 OptionSet 解析 width/height 为 int、fullscreenWidth/fullscreenHeight 为 OptionalInt，" +
            "读取 fullscreen/demo/disableMultiplayer/disableChat 布尔标志与 version 字符串，为窗口创建与游戏模式做准备。"),
        new NodeSpec("n6", "用户属性与账号数据组装",
            "GsonBuilder + PropertyMap.Serializer 创建 Gson；" +
            "aor.a(Gson, json, PropertyMap.class) 反序列化 userProperties/profileProperties；" +
            "hy.a(String) 解析或生成 uuid；组装 assetsDir/resourcePackDir（默认 assets/、resourcepacks/）与 quickPlay* 参数。"),
        new NodeSpec("n7", "启动前系统初始化（JFR/崩溃报告/计时）",
            "jfrProfile 开启时调用 bat.e.a(bar.a) 启用 JFR 性能采集；" +
            "o.h() 初始化 CrashReport（崩溃报告）静态状态；" +
            "acs.a()/acs.c()/ac.l() 启动数据校验与计时，fzr.a(AtomicLong) 记录启动时间戳。"),
        new NodeSpec("n8", "用户对象与 UserType 构造",
            "eoc$a.a(userType) 将字符串解析为 UserType 枚举（不识别时 Logger.warn(\"Unrecognized user type\")）；" +
            "new eoc(username, uuid, accessToken, clientId Optional, xuid Optional, userType) 构造用户对象。"),
        new NodeSpec("n9", "GameConfig 聚合配置构造",
            "依次构造 5 个子配置并聚合为 GameConfig：" +
            "new ezy$d(UserData: user+PropertyMap+Proxy)、new eha(WindowSettings: width/height/fullscreen)、" +
            "new ezy$a(FolderData: gameDir/resourcePackDir/assetsDir/assetIndex)、" +
            "new ezy$b(GameData: demo/version/versionType/disableMultiplayer/disableChat)、" +
            "new ezy$c(QuickPlayData: quickPlay 4 参数)，最后 new ezy(GameConfig)。"),
        new NodeSpec("n10", "关闭钩子与渲染线程初始化",
            "new Main$2(\"Client Shutdown Thread\") + r(UncaughtExceptionHandler) + Runtime.addShutdownHook 注册关闭钩子；" +
            "Thread.currentThread().setName(\"Render thread\")；" +
            "RenderSystem.initRenderThread() / RenderSystem.beginInitialization() 初始化渲染系统。"),
        new NodeSpec("n11", "Minecraft 客户端实例构造（窗口创建）",
            "new enn(ezy)（enn=Minecraft 客户端主类，extends bcr<Runnable>）构造客户端实例，内部完成窗口创建/资源与渲染初始化；" +
            "随后 RenderSystem.finishInitialization()。" +
            "异常分支：ezz -> Logger.warn(\"Failed to create window\") 直接 return；其他 Throwable -> o.a(t,\"Initializing game\") 崩溃报告 + apb.a(section) + enn.a/c 后 return。"),
        new NodeSpec("n12", "游戏线程与主循环启动（tick/render）",
            "enn.aL() 判断集成服务器模式：" +
            "分支 A（集成服务器）：new Main$3(\"Game thread\", enn) + Thread.start()，轮询等待 enn.q() 服务端就绪；" +
            "分支 B：RenderSystem.initGameThread(false) + enn.e() 运行主循环（每帧 window 事件轮询、tick 逻辑更新、render 渲染、帧率控制）。" +
            "异常时 Logger.error(\"Unhandled game exception\")。"),
        new NodeSpec("n13", "关闭退出流程",
            "主循环退出后：eif.a() 关闭序列（内存/资源释放）-> enn.p() stop（保存世界/停止服务）->" +
            "Thread.join() 等待游戏线程 -> enn.l() destroy（销毁渲染资源/窗口）；" +
            "InterruptedException -> Logger.error(\"Exception during client thread shutdown\")。" +
            "另注：静态块中 LogUtils.getLogger() 初始化日志器并设置 java.awt.headless=true。"),
    };

    public static void main(String[] args) throws Exception {
        Path outputDir = Path.of("E:", "CodeNode", "CodeNode", "output");
        Path docsDir = outputDir.resolve("docs");
        Files.createDirectories(outputDir);
        Files.createDirectories(docsDir);

        // 1) 构建工作流模型：13 个启动阶段节点 + 顺序连线
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node[] nodes = new WorkflowModel.Node[SPECS.length];
        for (int i = 0; i < SPECS.length; i++) {
            NodeSpec spec = SPECS[i];
            WorkflowModel.Node node = model.forceAddNode(spec.id(), spec.name(), i * 360, 0);
            node.prompt = spec.prompt();
            node.category = "项目分析";
            node.classificationKey = "analysis.java";
            node.artifact = "output/" + spec.id() + ".java";
            nodes[i] = node;
        }
        int edges = 0;
        for (int i = 0; i + 1 < nodes.length; i++) {
            if (!model.connect(nodes[i], nodes[i + 1])) {
                throw new IllegalStateException("connect failed: " + nodes[i].id + " -> " + nodes[i + 1].id);
            }
            edges++;
        }

        // 2) MARKDOWN 模式 Settings：markdownPath 指向蓝图 .md（output/docs 下）
        CnodeProjectCodec.Settings settings = new CnodeProjectCodec.Settings(
                WorkflowModel.Mode.MARKDOWN,
                "java",
                "generated/startup-chain",
                "docs/TeaCraft_Minecraft_StartupChain.md",
                "n1", -400, -100, 1.0,
                null, List.of());

        CnodeProjectCodec.Metadata metadata = new CnodeProjectCodec.Metadata(
                "teacraft-mc-startup-chain-" + UUID.randomUUID().toString().substring(0, 8),
                "Minecraft 1.21 客户端启动链路（Main.main）",
                Instant.now(),
                settings);

        // 3) 保存 .cnode 并回读验证
        CnodeProjectCodec codec = new CnodeProjectCodec();
        Path target = outputDir.resolve("TeaCraft_Minecraft_StartupChain.cnode");
        codec.save(target, model, metadata);
        System.out.println("SAVED=" + target.toAbsolutePath());

        CnodeProjectCodec.Loaded loaded = codec.load(target);
        System.out.println("LOADED mode=" + loaded.metadata().settings().mode());
        System.out.println("LOADED nodes=" + loaded.model().nodes().size());
        System.out.println("LOADED edges=" + loaded.model().edges().size());
        System.out.println("LOADED entry=" + loaded.metadata().settings().entryNodeId());
        System.out.println("LOADED markdownPath=" + loaded.metadata().settings().markdownPath());
        for (WorkflowModel.Node node : loaded.model().nodes()) {
            System.out.println("  node " + node.id + " | " + node.name);
        }
    }
}
