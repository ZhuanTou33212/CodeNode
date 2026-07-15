package local.codenode;

import org.junit.jupiter.api.Test;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class JsonTest {
    @Test void roundTripsNestedUtf8Data() {
        Map<String,Object> source=new LinkedHashMap<>();source.put("name","节点\nA");source.put("count",3);source.put("items",List.of(true,"x"));
        Map<String,Object> parsed=Json.object(Json.stringify(source));
        assertEquals("节点\nA",parsed.get("name"));assertEquals(3L,parsed.get("count"));assertEquals(List.of(true,"x"),parsed.get("items"));
    }
    @Test void rejectsTrailingData(){assertThrows(IllegalArgumentException.class,()->Json.parse("{}x"));}
}
