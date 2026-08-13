package local.codenode;

import local.codenode.agent.AgentContext;
import local.codenode.agent.AgentInfoSnapshot;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.zip.*;

import static org.junit.jupiter.api.Assertions.*;

class CnodeProjectCodecTest {
    @TempDir Path temp;
    private final CnodeProjectCodec codec=new CnodeProjectCodec();

    @Test void roundTripPreservesGraphWorkspaceAndOutputProfiles() throws Exception {
        WorkflowModel model=model();WorkflowModel.Node target=model.nodes().getLast();
        model.edges().getFirst().reroutes().add(new WorkflowModel.Reroute(220,65));
        var settings=new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN,"go","output/program","output/agent",target.id,31,-22,1.25,target.id);
        Path file=temp.resolve("demo.cnode");codec.save(file,model,new CnodeProjectCodec.Metadata("doc-demo","演示",Instant.parse("2026-07-15T00:00:00Z"),settings));

        CnodeProjectCodec.Loaded loaded=codec.load(file);assertFalse(loaded.readOnly());assertEquals("doc-demo",loaded.metadata().documentId());assertEquals(2,loaded.model().nodes().size());assertEquals(1,loaded.model().edges().size());assertEquals(CnodeProjectCodec.FORMAT_VERSION,"1.1");
        WorkflowModel.Node restored=loaded.model().byId(target.id);assertEquals("生成产物",restored.name);assertEquals("string",restored.inputs.getFirst().dataType);assertEquals("any",restored.inputs.getFirst().declaredType);assertEquals(WorkflowModel.Status.IDLE,restored.status);
        assertEquals(220,loaded.model().edges().getFirst().reroutes().getFirst().x);assertEquals(WorkflowModel.Mode.MARKDOWN,loaded.metadata().settings().mode());assertEquals("output/agent",loaded.metadata().settings().markdownPath());assertEquals(31,loaded.metadata().settings().panX());assertEquals(1.25,loaded.metadata().settings().zoom());assertEquals(target.id,loaded.metadata().settings().selectedNodeId());
    }

    @Test void archiveStartsWithUncompressedMimeMarkerAndHasRequiredEntries() throws Exception {
        Path file=save("structure.cnode");Set<String> names=new LinkedHashSet<>();try(ZipInputStream zip=new ZipInputStream(Files.newInputStream(file),StandardCharsets.UTF_8)){ZipEntry first=zip.getNextEntry();assertEquals("mimetype",first.getName());assertEquals(ZipEntry.STORED,first.getMethod());names.add(first.getName());for(ZipEntry entry;(entry=zip.getNextEntry())!=null;)names.add(entry.getName());}
        assertTrue(names.containsAll(Set.of("manifest.json","graph.json","workspace.json","output-profiles.json","integrity.json")));
    }

    @Test void sharedRerouteIdentitySurvivesRoundTrip() throws Exception {
        WorkflowModel model=new WorkflowModel();WorkflowModel.Node source=model.addNode(0,0),first=model.addNode(300,0),second=model.addNode(300,200);model.connect(source,first);WorkflowModel.Reroute point=model.addReroute(model.edges().getFirst(),150,80);model.connect(source,second);model.edges().getLast().reroutes().add(point);Path file=temp.resolve("shared.cnode");codec.save(file,model,metadata(model));WorkflowModel loaded=codec.load(file).model();assertEquals(2,loaded.edges().size());assertSame(loaded.edges().getFirst().reroutes().getFirst(),loaded.edges().getLast().reroutes().getFirst());
    }

    @Test void roundTripPreservesMultiNodeSelection() throws Exception {
        WorkflowModel model=model();List<String> selected=model.nodes().stream().map(node->node.id).toList();String primary=selected.getLast();var settings=new CnodeProjectCodec.Settings(WorkflowModel.Mode.EXECUTABLE,"java","output/app","output/docs",primary,0,0,1.0,primary,selected);Path file=temp.resolve("multi-selection.cnode");codec.save(file,model,new CnodeProjectCodec.Metadata("doc-selection","选择",Instant.now(),settings));var restored=codec.load(file).metadata().settings();assertEquals(selected,restored.selectedNodeIds());assertEquals(primary,restored.selectedNodeId());
    }

    @Test void roundTripPreservesNestedGroupParentScopesAndCurrentFocus() throws Exception {
        WorkflowModel model = new WorkflowModel();
        WorkflowModel.Node root = model.addGroupNode(0, 0, "根组");
        WorkflowModel.Node nested = model.addGroupNode(40, 40, "子组"); nested.parentScopeId = root.id;
        WorkflowModel.Node leaf = model.addNode(80, 80); leaf.parentScopeId = nested.id;
        var settings = new CnodeProjectCodec.Settings(WorkflowModel.Mode.MARKDOWN, "java", "output/app", "output/docs", null, 12, 24, 1.2, null, List.of(), nested.id);
        Path file = temp.resolve("nested-focus.cnode");
        codec.save(file, model, new CnodeProjectCodec.Metadata("nested", "嵌套", Instant.now(), settings));
        CnodeProjectCodec.Loaded loaded = codec.load(file);
        assertEquals(nested.id, loaded.metadata().settings().currentGroupId());
        assertEquals(root.id, loaded.model().byId(nested.id).parentScopeId);
        assertEquals(nested.id, loaded.model().byId(leaf.id).parentScopeId);
    }
    @Test void roundTripPreservesStageTwoNodeMetadataAndCodeDraft() throws Exception {WorkflowModel model=new WorkflowModel();var node=model.addNode(10,10);node.nodeKind=WorkflowModel.NodeKind.CALCULATION;node.valueType="number";node.operation="add";node.classificationKey="calculation.scalar";var slot=model.ensureNodeSlot(node);slot.activeRevision=2;slot.activeCode="old";slot.draft=new WorkflowModel.CodeDraft("request-1",2,"new","calculation.scalar");Path file=temp.resolve("stage2.cnode");codec.save(file,model,metadata(model));WorkflowModel loaded=codec.load(file).model();WorkflowModel.Node restored=loaded.byId(node.id);assertEquals(WorkflowModel.NodeKind.CALCULATION,restored.nodeKind);assertEquals("add",restored.operation);assertEquals("new",loaded.codeSlot("node:"+node.id).draft.code);assertEquals(2,loaded.codeSlot("node:"+node.id).activeRevision);}

    @Test void atomicallyReplacesProjectAndKeepsBackup() throws Exception {
        Path file=save("backup.cnode");byte[] first=Files.readAllBytes(file);WorkflowModel changed=model();changed.nodes().getFirst().prompt="第二版";codec.save(file,changed,metadata(changed));assertTrue(Files.isRegularFile(CnodeProjectCodec.backupPath(file)));assertArrayEquals(first,Files.readAllBytes(CnodeProjectCodec.backupPath(file)));assertEquals("第二版",codec.load(file).model().nodes().getFirst().prompt);
    }

    @Test void rejectsTamperedContentAndUnsafePaths() throws Exception {
        Path file=save("tampered.cnode");Map<String,byte[]> entries=read(file);entries.put("graph.json","{\"nodes\":[],\"edges\":[]}".getBytes(StandardCharsets.UTF_8));write(file,entries);IOException integrity=assertThrows(IOException.class,()->codec.load(file));assertTrue(integrity.getMessage().contains("摘要校验失败"));
        WorkflowModel unsafe=model();unsafe.nodes().getFirst().artifact="../escape.java";assertThrows(IOException.class,()->codec.save(temp.resolve("unsafe.cnode"),unsafe,metadata(unsafe)));
    }

    @Test void optionalAgentAccessorsVerifyIntegrity() throws Exception {
        Path file = temp.resolve("agent-tampered.cnode");
        WorkflowModel model = model();
        codec.save(file, model, metadata(model),
                AgentContext.of("session", "summary", List.of(Map.of("role", "user", "content", "hello"))),
                new AgentInfoSnapshot(Map.of("version", "0.16"), Map.of("jdk", "21")));
        Map<String, byte[]> entries = read(file);
        entries.put("agent-context.json", "{\"schemaVersion\":1}".getBytes(StandardCharsets.UTF_8));
        write(file, entries);
        assertThrows(IOException.class, () -> codec.loadAgentContext(file));
        assertThrows(IOException.class, () -> codec.loadAgentInfo(file));
    }

    @Test void newerMajorVersionLoadsReadOnlyAndRecoveryFindsNewerCheckpoint() throws Exception {
        Path file=save("future.cnode");Map<String,byte[]> entries=read(file);Map<String,Object> manifest=Json.object(text(entries.get("manifest.json")));manifest.put("formatVersion","2.0");entries.put("manifest.json",Json.stringify(manifest).getBytes(StandardCharsets.UTF_8));entries.put("integrity.json",integrity(entries));write(file,entries);assertTrue(codec.load(file).readOnly());
        CnodeRecoveryService recovery=new CnodeRecoveryService(codec);CnodeProjectCodec.Loaded loaded=codec.load(file);Path checkpoint=recovery.saveCheckpoint(temp,loaded.model(),loaded.metadata());Files.setLastModifiedTime(file,FileTime.from(Instant.now().minusSeconds(5)));Files.setLastModifiedTime(checkpoint,FileTime.from(Instant.now()));assertEquals(checkpoint,recovery.newerCheckpoint(temp,loaded.metadata().documentId(),file).orElseThrow());recovery.clear(temp,loaded.metadata().documentId());assertFalse(Files.exists(checkpoint));
    }

    @Test void rejectsZipPathTraversal() throws Exception {
        Path file=temp.resolve("traversal.cnode");try(ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(file))){stored(zip,"mimetype",CnodeProjectCodec.MIME.getBytes(StandardCharsets.UTF_8));zip.putNextEntry(new ZipEntry("../evil"));zip.write(1);zip.closeEntry();}IOException error=assertThrows(IOException.class,()->codec.load(file));assertTrue(error.getMessage().contains("非法 ZIP 路径"));
    }

    @Test void loadedProjectProducesStageTwoMarkdownRequest() throws Exception {
        Path file=save("queue-source.cnode");CnodeProjectCodec.Loaded loaded=codec.load(file);WorkflowModel model=loaded.model();WorkflowModel.Node selected=model.nodes().getLast();WorkflowModel.Node output=model.addGroupOutput(500,80,"主输出");model.connect(selected,selected.outputs.getFirst(),output,output.inputs.getFirst());QueueService queue=new QueueService(temp.resolve("queue-project"));var submission=queue.submit(model,WorkflowModel.Mode.MARKDOWN,QueueService.SubmitTarget.group(output),"java","output/docs");Map<String,Object> request=Json.object(Files.readString(submission.inboxPath().resolve("request.json")));assertEquals("markdown-blueprint",request.get("mode"));assertEquals("build-markdown-group",request.get("action"));assertEquals("4.0",request.get("schemaVersion"));
    }

    private Path save(String name) throws Exception {Path file=temp.resolve(name);WorkflowModel model=model();codec.save(file,model,metadata(model));return file;}
    private static CnodeProjectCodec.Metadata metadata(WorkflowModel model){String selected=model.nodes().getLast().id;return new CnodeProjectCodec.Metadata("doc-test","测试",Instant.parse("2026-07-15T00:00:00Z"),new CnodeProjectCodec.Settings(WorkflowModel.Mode.EXECUTABLE,"java","output/app","output/docs",selected,0,0,1.0,selected));}
    private static WorkflowModel model(){WorkflowModel model=new WorkflowModel();WorkflowModel.Node source=model.addNode(10,20),target=model.addNode(300,80);source.name="输入与解析";source.outputs.getFirst().declaredType="string";source.outputs.getFirst().dataType="string";target.name="生成产物";target.inputs.getFirst().declaredType="any";target.inputs.getFirst().dataType="any";model.connect(source,target);return model;}
    private static Map<String,byte[]> read(Path file) throws Exception {LinkedHashMap<String,byte[]> entries=new LinkedHashMap<>();try(ZipInputStream zip=new ZipInputStream(Files.newInputStream(file),StandardCharsets.UTF_8)){for(ZipEntry entry;(entry=zip.getNextEntry())!=null;)entries.put(entry.getName(),zip.readAllBytes());}return entries;}
    private static void write(Path file,Map<String,byte[]> entries) throws Exception {try(ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(file,StandardOpenOption.TRUNCATE_EXISTING),StandardCharsets.UTF_8)){stored(zip,"mimetype",entries.get("mimetype"));for(var entry:entries.entrySet())if(!entry.getKey().equals("mimetype")){zip.putNextEntry(new ZipEntry(entry.getKey()));zip.write(entry.getValue());zip.closeEntry();}}}
    private static void stored(ZipOutputStream zip,String name,byte[] data) throws Exception {CRC32 crc=new CRC32();crc.update(data);ZipEntry entry=new ZipEntry(name);entry.setMethod(ZipEntry.STORED);entry.setSize(data.length);entry.setCompressedSize(data.length);entry.setCrc(crc.getValue());zip.putNextEntry(entry);zip.write(data);zip.closeEntry();}
    private static byte[] integrity(Map<String,byte[]> entries) throws Exception {LinkedHashMap<String,Object> files=new LinkedHashMap<>();for(String name:List.of("manifest.json","graph.json","workspace.json","output-profiles.json"))files.put(name,HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(entries.get(name))));return Json.stringify(Map.of("algorithm","SHA-256","files",files)).getBytes(StandardCharsets.UTF_8);}
    private static String text(byte[] data){return new String(data,StandardCharsets.UTF_8);}
}
