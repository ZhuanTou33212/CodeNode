package local.codenode;

import java.io.IOException;
import java.nio.file.*;
import java.time.Instant;
import java.util.Optional;

public final class CnodeRecoveryService {
    private final CnodeProjectCodec codec;
    public CnodeRecoveryService(CnodeProjectCodec codec){this.codec=codec;}

    public Path checkpointPath(Path projectRoot,String documentId){return projectRoot.toAbsolutePath().normalize().resolve(".codenode/recovery").resolve(documentId).resolve("checkpoint.cnode");}

    public Path saveCheckpoint(Path projectRoot,WorkflowModel model,CnodeProjectCodec.Metadata metadata) throws IOException {
        Path checkpoint=checkpointPath(projectRoot,metadata.documentId());codec.save(checkpoint,model,metadata);return checkpoint;
    }

    public Optional<Path> newerCheckpoint(Path projectRoot,String documentId,Path projectFile) throws IOException {
        Path checkpoint=checkpointPath(projectRoot,documentId);if(!Files.isRegularFile(checkpoint))return Optional.empty();Instant checkpointTime=Files.getLastModifiedTime(checkpoint).toInstant();Instant projectTime=Files.isRegularFile(projectFile)?Files.getLastModifiedTime(projectFile).toInstant():Instant.EPOCH;return checkpointTime.isAfter(projectTime)?Optional.of(checkpoint):Optional.empty();
    }

    public void clear(Path projectRoot,String documentId) throws IOException {
        Path directory=checkpointPath(projectRoot,documentId).getParent();if(directory==null||!Files.exists(directory))return;Files.deleteIfExists(directory.resolve("checkpoint.cnode"));Files.deleteIfExists(directory.resolve("checkpoint.cnode.bak"));try{Files.delete(directory);}catch(DirectoryNotEmptyException ignored){}
    }
}
