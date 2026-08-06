package local.codenode;

import org.junit.jupiter.api.Test;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class JsonTest {
    @Test void roundTripsNestedUtf8Data() {
        Map<String,Object> source=new LinkedHashMap<>();source.put("name","节点\nA");source.put("count",3);source.put("items",List.of(true,"x"));
        Map<String,Object> parsed=Json.object(Json.stringify(source));
        assertEquals("节点\nA",parsed.get("name"));assertEquals(3L,parsed.get("count"));assertEquals(List.of(true,"x"),parsed.get("items"));
    }
    @Test void rejectsTrailingData(){assertThrows(IllegalArgumentException.class,()->Json.parse("{}x"));}
    @Test void bundledCnodeSchemaIsValidJson() throws Exception {try(var stream=getClass().getResourceAsStream("/schemas/cnode-project-1.1.schema.json")){assertNotNull(stream);Map<String,Object> schema=Json.object(new String(stream.readAllBytes(),StandardCharsets.UTF_8));assertEquals("https://codenode.local/schema/project-1.1.json",schema.get("$id"));}}
}
