package local.codenode;

import java.util.*;

/** Stable node classifications shared by Agent validation, persistence and rendering. */
public final class NodeRegistry {
    private static final Map<String,String> CATEGORIES=Map.ofEntries(
        Map.entry("foundation.object","基础"),
        Map.entry("scope.flow","范围与流程控制"),
        Map.entry("scope.group","节点组"),
        Map.entry("file.source","文件"),
        Map.entry("value.scalar","数值"),
        Map.entry("value.vector","向量与数组"),
        Map.entry("value.array","向量与数组"),
        Map.entry("value.boolean","布尔值"),
        Map.entry("text.string","文本"),
        Map.entry("io.input","输入与输出"),
        Map.entry("io.output","输入与输出"),
        Map.entry("io.group-output","输入与输出"),
        Map.entry("io.group-input","输入与输出"),
        Map.entry("io.node-group-input","节点组"),
        Map.entry("io.node-group-output","节点组"),
        Map.entry("io.capture","捕获"),
        Map.entry("calculation.scalar","数值"),
        Map.entry("calculation.vector","向量与数组"),
        Map.entry("calculation.boolean","布尔值"),
        Map.entry("asset.image","资产"),
        Map.entry("asset.model","资产"),
        Map.entry("asset.texture","资产"),
        Map.entry("asset.animation","资产"),
        Map.entry("asset.particle","资产"),
        Map.entry("asset.language","资产"),
        Map.entry("asset.audio","资产"),
        Map.entry("asset.video","资产"),
        Map.entry("asset.other","资产"),
        Map.entry("agent.custom","Agent 生成"),
        Map.entry("analysis.java","项目分析"),
        Map.entry("analysis.kotlin","项目分析"),
        Map.entry("analysis.python","项目分析"),
        Map.entry("analysis.go","项目分析"),
        Map.entry("analysis.powershell","项目分析"),
        Map.entry("analysis.typescript","项目分析"),
        Map.entry("analysis.javascript","项目分析"),
        Map.entry("analysis.default","项目分析")
    );
    private NodeRegistry(){}
    public static boolean isKnown(String key){return key!=null&&(CATEGORIES.containsKey(key)||key.startsWith("analysis."));}
    public static String category(String key){return key!=null&&key.startsWith("analysis.")?"项目分析":CATEGORIES.getOrDefault(key,"基础");}
    public static Set<String> keys(){return CATEGORIES.keySet();}

    public static List<String> operations(WorkflowModel.Node node){
        if(node==null)return List.of();
        if(node.nodeKind==WorkflowModel.NodeKind.CONDITION)return List.of("equal","not-equal","greater","greater-equal","less","less-equal","inside","outside","is-null","not-null","exists","missing","and","or","not","xor","nand","nor","xnor");
        if(node.nodeKind!=WorkflowModel.NodeKind.CALCULATION)return List.of();String type=node.valueType.toLowerCase(Locale.ROOT);
        if(type.startsWith("array"))return List.of("create","get","set","length","append","concat","slice","contains","index-of");
        if(type.contains("color"))return List.of("mix","add","subtract","multiply","divide","darken","lighten","clamp","invert");
        if(type.contains("vector")||type.contains("normal"))return List.of("add","subtract","multiply","divide","scale","dot","cross","normalize","length","distance","project","reflect");
        if(type.contains("integer"))return List.of("add","subtract","multiply","integer-divide","remainder","absolute","minimum","maximum","gcd","lcm","bit-and","bit-or","bit-xor","shift-left","shift-right");
        return List.of("add","subtract","multiply","divide","multiply-add","power","log","sqrt","absolute","minimum","maximum","modulo","sign","round","floor","ceil","sin","cos","tan");
    }

    public static String operationForLabel(WorkflowModel.Node node,String label){List<String> choices=operations(node);if(choices.isEmpty())return "";String value=switch(label){case "AND"->"and";case "OR"->"or";case "NOT"->"not";case "XOR"->"xor";case "范围判断"->"inside";case "为空判断"->"is-null";case "数组计算"->"append";case "颜色计算"->"mix";case "向量计算"->"add";default->choices.getFirst();};return choices.contains(value)?value:choices.getFirst();}

    public static int applyOperation(WorkflowModel model,WorkflowModel.Node node,String operation){List<String> choices=operations(node);if(!choices.contains(operation))throw new IllegalArgumentException("当前节点不支持运算："+operation);node.operation=operation;List<WorkflowModel.Port> inputs=new ArrayList<>();String result=node.valueType;
        if(node.nodeKind==WorkflowModel.NodeKind.CONDITION){result="boolean";if(Set.of("not","is-null","not-null","exists","missing").contains(operation))inputs.add(port("value","值",operation.equals("not")?"boolean":"any"));else if(Set.of("and","or","xor","nand","nor","xnor").contains(operation)){inputs.add(port("a","A","boolean"));inputs.add(port("b","B","boolean"));}else if(Set.of("inside","outside").contains(operation)){inputs.add(port("value","值","number"));inputs.add(port("minimum","最小值","number"));inputs.add(port("maximum","最大值","number"));}else{inputs.add(port("a","A","any"));inputs.add(port("b","B","any"));}}
        else if(node.valueType.startsWith("array")){String array=node.valueType;switch(operation){case "create"->inputs.add(port("value","元素","any"));case "get"->{inputs.add(port("array","数组",array));inputs.add(port("index","索引","integer"));result="any";}case "set"->{inputs.add(port("array","数组",array));inputs.add(port("index","索引","integer"));inputs.add(port("value","元素","any"));}case "length"->{inputs.add(port("array","数组",array));result="integer";}case "append"->{inputs.add(port("array","数组",array));inputs.add(port("value","元素","any"));}case "concat"->{inputs.add(port("a","数组 A",array));inputs.add(port("b","数组 B",array));}case "slice"->{inputs.add(port("array","数组",array));inputs.add(port("start","开始","integer"));inputs.add(port("end","结束","integer"));}case "contains"->{inputs.add(port("array","数组",array));inputs.add(port("value","元素","any"));result="boolean";}case "index-of"->{inputs.add(port("array","数组",array));inputs.add(port("value","元素","any"));result="integer";}}}
        else{boolean unary=Set.of("absolute","sqrt","sign","round","floor","ceil","sin","cos","tan","normalize","length","invert").contains(operation);inputs.add(port("a",unary?"值":"A",node.valueType));if(!unary)inputs.add(port("b","B",operation.equals("scale")?"number":node.valueType));if(operation.equals("multiply-add"))inputs.add(port("c","C",node.valueType));if(Set.of("dot","length","distance").contains(operation))result="number";}
        return model.replacePorts(node,inputs,List.of(new WorkflowModel.Port("result","结果",result,false)));
    }

    private static WorkflowModel.Port port(String id,String name,String type){return new WorkflowModel.Port(id,name,type,true);}

    private static final Map<String,String> EXT_CATEGORY=new HashMap<>();
    static{
        String[] image={"png","jpg","jpeg","gif","bmp","svg","webp","tiff","tif","ico","psd","ai","raw","cr2","nef","heif","heic","dds","hdr","exr","tga"};
        String[] model={"stl","fbx","obj","gltf","glb","blend","3ds","dae","usd","usdz","abc","ply","x3d","max","ma","mb","3mf","amf","step","stp","iges","igs","brep"};
        String[] texture={"png","jpg","jpeg","tga","dds","bmp","tiff","tif","exr","hdr","psd","svg"};
        String[] animation={"fbx","gltf","glb","dae","usd","abc","bvh","htr","trc","asf","amc","c3d","mocap"};
        String[] particle={"pcf","pix","abr","tpl","efk","efkproj","spr","npfx","vfx"};
        String[] language={"java","py","js","ts","c","cpp","h","hpp","cs","go","rs","php","rb","swift","kt","scala","lua","r","m","mm","ps1","sh","bat","cmd","sql","html","css","scss","less","xml","json","yaml","yml","toml","ini","cfg","conf","properties","gradle","proto"};
        String[] audio={"mp3","wav","ogg","flac","wma","aac","m4a","opus","aiff","mid","midi"};
        String[] video={"mp4","avi","mkv","mov","wmv","webm","flv","m4v","mpeg","mpg","3gp"};
        for(String ext:image)EXT_CATEGORY.put(ext,"image");
        for(String ext:model)EXT_CATEGORY.put(ext,"model");
        for(String ext:texture)EXT_CATEGORY.put(ext,"texture");
        for(String ext:animation)EXT_CATEGORY.put(ext,"animation");
        for(String ext:particle)EXT_CATEGORY.put(ext,"particle");
        for(String ext:language)EXT_CATEGORY.put(ext,"language");
        for(String ext:audio)EXT_CATEGORY.put(ext,"audio");
        for(String ext:video)EXT_CATEGORY.put(ext,"video");
    }

    public static String classifyExtension(String filename){
        if(filename==null||filename.isBlank())return "other";
        String ext="";
        int dot=filename.lastIndexOf('.');
        if(dot>=0)ext=filename.substring(dot+1).toLowerCase(Locale.ROOT);
        return EXT_CATEGORY.getOrDefault(ext,"other");
    }

    public static String assetTypeLabel(String assetType){
        return switch(assetType){
            case "image"->"图像";
            case "model"->"模型";
            case "texture"->"贴图";
            case "animation"->"动画";
            case "particle"->"粒子";
            case "language"->"语言";
            case "audio"->"音频";
            case "video"->"视频";
            default->"其他";
        };
    }

    public static List<String> allAssetTypes(){
        return List.of("image","model","texture","animation","particle","language","audio","video","other");
    }

    public static boolean isImageAsset(String relativePath){
        return "image".equals(classifyExtension(relativePath))||"texture".equals(classifyExtension(relativePath));
    }
}
