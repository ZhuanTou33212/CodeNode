import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public final class CreateDesktopFolder {
    private CreateDesktopFolder() {
    }

    public static void main(String[] args) throws IOException {
        String folderName = args.length > 0 ? args[0] : "CodeNodeFolder";
        Path relativeName = Path.of(folderName);
        if (folderName.isBlank() || relativeName.isAbsolute() || relativeName.getNameCount() != 1
                || folderName.equals(".") || folderName.equals("..")) {
            throw new IllegalArgumentException("Folder name must be one non-empty path segment.");
        }

        Path desktop = Path.of(System.getProperty("user.home"), "Desktop").toAbsolutePath().normalize();
        if (!Files.isDirectory(desktop)) {
            throw new IOException("Desktop directory was not found: " + desktop);
        }

        Path target = desktop.resolve(relativeName).normalize();
        if (!desktop.equals(target.getParent())) {
            throw new IllegalArgumentException("Folder path must stay directly under Desktop.");
        }

        Files.createDirectories(target);
        System.out.println("Created folder: " + target);
    }
}
