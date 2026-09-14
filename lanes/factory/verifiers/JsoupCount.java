///usr/bin/env jbang "$0" "$@" ; exit $?
//DEPS org.jsoup:jsoup:1.18.3
// lanes/factory/verifiers/JsoupCount.java — count a take with the forecast's vocabulary, via jsoup.
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import java.nio.file.*;
public class JsoupCount {
  public static void main(String[] a) throws Exception {
    Document d = Jsoup.parse(Files.readString(Path.of(a[0])));
    int pages = Math.max(1, d.select("section[data-page]").size());
    int elements = d.select("h1,h2,h3,p,li,button,a,section,img,article").size();
    StringBuilder named = new StringBuilder();
    for (var e : d.select("[data-named]")) { if (named.length() > 0) named.append("\",\""); named.append(e.attr("data-named").replace("\\", "\\\\").replace("\"", "\\\"")); }
    System.out.println("{\"pages\":" + pages + ",\"elements\":" + elements + ",\"title\":\"" + d.title().replace("\"", "\\\"") + "\",\"named_text\":[" + (named.length() > 0 ? "\"" + named + "\"" : "") + "]}");
  }
}
