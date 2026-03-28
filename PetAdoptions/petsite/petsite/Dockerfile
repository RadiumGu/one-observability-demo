FROM mcr.microsoft.com/dotnet/aspnet:7.0-bullseye-slim AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:7.0-bullseye-slim AS build
WORKDIR /src
COPY . .
RUN dotnet restore "PetSite.csproj"
RUN dotnet build "PetSite.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "PetSite.csproj" -c Release -o /app/publish

FROM base AS final
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "PetSite.dll"]
