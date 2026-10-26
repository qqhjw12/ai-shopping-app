# 多阶段构建：mall-ai 作为 mall fork 的一个 Maven 模块参与编译。
# 构建上下文（build context）必须是 mall fork 根目录（见 docker-compose.yml 的 build.context）。
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /workspace
# 复制整个 mall fork（含 mall-ai 模块、mall-common、mall-mbg）
COPY . .
# -pl mall-ai 只编 mall-ai；-am 自动带上其上游依赖 mall-common / mall-mbg；跳过测试加速构建
RUN mvn -q -pl mall-ai -am -DskipTests package

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build mall-ai/target/mall-ai.jar app.jar
EXPOSE 8081
ENV JAVA_OPTS="-Xms256m -Xmx512m"
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]
