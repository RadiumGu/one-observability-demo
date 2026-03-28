FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/aspnet:8.0 AS base
WORKDIR /app
EXPOSE 80
EXPOSE 443

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN dotnet restore "trafficgenerator.csproj"
RUN dotnet build "trafficgenerator.csproj" -c Release -o /app/build

FROM build AS publish
ARG TARGETARCH
RUN dotnet publish "trafficgenerator.csproj" -c Release -o /app/publish -a $TARGETARCH

FROM base AS final
WORKDIR /app
#ENV DOTNET_ENVIRONMENT=Development
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "trafficgenerator.dll"]
